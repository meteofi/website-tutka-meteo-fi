// Sääsanomat — METAR station plots at Finnish aerodromes.
//
// Cross-pane pattern (placeNames / gliders / rescueVessels): ONE shared
// VectorSource, one VectorLayer per pane through the paneDeps factory, so split
// screen costs no extra fetching.
//
// CLOCK-COUPLED, unlike the other live layers here. Aircraft and vessels report
// where they are now and there is no history to scrub, but MET Norway hands back
// 24 h of METAR per station in the same request — so the plot can show what the
// aerodrome was reporting at the frame being displayed, and scrubbing the radar
// back through a front shows the wind backing with it. That is the whole reason
// this layer follows the cursor: the data was already in hand.
//
// Reports come every 30 minutes while the animation steps every 5, so six frames
// share one report. The plot therefore always states the report's own time — a
// 30-minute granularity that explains itself rather than looking stale.
//
// NO STATION LIST OF ITS OWN. The ICAO codes, positions AND whether an aerodrome
// issues a METAR at all come from the bundled eAIP snapshots, handed in by
// src/airfields.js, which is why this layer is 200 lines rather than 400.
//
// The generator decides the last of those per country, and its reasoning is
// worth knowing here: in Finland AD 2.11's "associated MET office" is an exact
// predictor, so the 24 flagged aerodromes are precisely the 24 that answer; in
// France it predicts nothing useful, so every AD 2 aerodrome is flagged and the
// source below narrows to whoever replies on the first request. Either way this
// layer asks about what it is given and keeps what answers.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';

import createMetarSource from './metarSource';
import { reportAt } from './metarParse';
import { createStationPlotStyle, createPlotFeature } from './stationPlot';

// Plots draw from about z6 in. Web Mercator resolution is 156543/2^z, so z6 is
// 2446 m/px and this threshold sits just above it.
//
// It started at 700 (z8 and closer), on the reasoning that a full station model
// at synoptic zoom would be unreadable and would bury the radar. Widened on
// request: at z6 the whole country is in view, and being able to see at a glance
// which fields are green and which are magenta is worth more than the crowding
// costs — the plots do not declutter, so where two aerodromes are close their
// models overlap rather than one disappearing.
const MAX_RESOLUTION = 2500;

// How old a report may be before the plot says so. Reports are half-hourly, so
// anything past about two of them means the station has gone quiet rather than
// simply not having reported yet.
const STALE_MS = 90 * 60 * 1000;

export default function initMetar({ telemetry, stations } = {}) {
  const source = new VectorSource({
    attributions: 'METAR © <a href="https://www.met.no/">MET Norway</a> (CC BY 4.0)',
  });
  const features = new Map(); // icao -> Feature
  const positions = new Map(); // icao -> map coordinates
  const client = createMetarSource();

  let enabled = false;
  let cursorMs = Date.now();
  let stationsLoaded = false;

  // The aerodrome positions, from the snapshots src/airfields.js has already
  // fetched and parsed for the aerodrome layer. Every station worth asking about
  // is in here; the rest simply never get a feature.
  async function loadStations() {
    if (stationsLoaded) return;
    const records = await stations();
    // `metar` marks the aerodromes worth asking about. A snapshot old enough to
    // predate the flag carries none at all, and falling back to every aerodrome
    // keeps the layer working rather than drawing nothing — the source narrows
    // to the repliers on its next refresh either way.
    const flagged = records.some((r) => r.metar);
    records.forEach((r) => {
      if (r.icao && r.coordinates && (r.metar || !flagged)) {
        positions.set(r.icao, fromLonLat(r.coordinates));
      }
    });
    stationsLoaded = true;
  }

  // Show, for every station, the report that was current at the cursor.
  function render() {
    if (!enabled) return;
    client.entries().forEach(([icao, reports]) => {
      const at = positions.get(icao);
      if (!at) return;
      // The report current at the displayed frame. A cursor past the newest —
      // the nowcast frames — clamps to the newest rather than blanking, which
      // would read as an outage instead of "nothing newer exists yet".
      const newest = reports[reports.length - 1];
      const report = cursorMs >= newest.timeMs ? newest : reportAt(reports, cursorMs);
      let feature = features.get(icao);
      if (!report) {
        // Before the oldest report held: the station has nothing to say about
        // this moment, so it shows nothing rather than something from later.
        if (feature) {
          source.removeFeature(feature);
          features.delete(icao);
        }
        return;
      }
      if (!feature) {
        feature = createPlotFeature(icao, at);
        features.set(icao, feature);
        source.addFeature(feature);
      }
      feature.set('report', report, true);
      feature.set('stale', cursorMs - report.timeMs > STALE_MS, true);
      feature.changed();
    });
    syncSelection();
  }

  const styleLight = createStationPlotStyle({ theme: 'light' });
  const styleDark = createStationPlotStyle({ theme: 'dark' });

  //
  // SELECTION -> TELEMETRY STRIP
  //
  // The same panel the aircraft, trains and vessels use. For a METAR the useful
  // readings are the ones a pilot reads off the report, plus the raw text, which
  // is what an aviator actually quotes to anyone else.
  const OWNER = 'metar';
  let selectedIcao = null;

  // Temperature and dew point as the report pairs them. Either one alone is
  // still worth stating, so a missing partner leaves the other standing rather
  // than blanking the column.
  function tempPair(tempC, dewpC) {
    const t = Number.isFinite(tempC) ? String(Math.round(tempC)) : null;
    const d = Number.isFinite(dewpC) ? String(Math.round(dewpC)) : null;
    if (t === null && d === null) return '–';
    return `${t === null ? '–' : t}/${d === null ? '–' : d}\u2009°C`;
  }

  // Visibility as an aerodrome states it: metres while they matter, kilometres
  // once they do not. The 5 km boundary is where the report itself changes
  // resolution — below it METAR steps in hundreds of metres, above it in
  // thousands — so it is also where the metre stops carrying information.
  function visibility(visM) {
    if (!Number.isFinite(visM)) return '–';
    if (visM < 5000) return `${Math.round(visM)}\u2009m`;
    const km = visM / 1000;
    // 9999 is the report's "10 km or more"; it must not print as 10.0.
    return `${km >= 10 ? Math.round(km) : km.toFixed(1)}\u2009km`;
  }

  function payloadFor(feature) {
    const report = feature.get('report');
    if (!report) return null;
    const { wind } = report;
    let windValue = '–';
    if (wind) {
      if (wind.calm) windValue = 'tyyni';
      else if (wind.variable) windValue = `VRB ${Math.round(wind.speedKt)}\u2009kt`;
      else {
        // Gusts in the report's own notation — 25G38 rather than 25 (38) —
        // which reads the same way as the raw METAR sitting in the subtitle
        // above it, and is narrower, which matters in a six-column strip on a
        // phone.
        const gust = Number.isFinite(wind.gustKt) ? `G${Math.round(wind.gustKt)}` : '';
        windValue = `${String(Math.round(wind.direction)).padStart(3, '0')}° ${Math.round(wind.speedKt)}${gust}\u2009kt`;
      }
    }
    const ageMin = Math.max(0, Math.round((cursorMs - report.timeMs) / 60000));
    const clock = new Date(report.timeMs)
      .toLocaleTimeString('fi', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return {
      icon: 'cloud',
      title: report.icao,
      // The raw report: the thing a pilot would read aloud, and the only form
      // that carries everything this panel does not have room for.
      subtitle: report.raw,
      // The report's own time, in UTC as aviation always states it, plus how far
      // it is from the frame being displayed.
      status: `${clock} UTC${ageMin > 0 ? ` · ${ageMin} min` : ''}`,
      metrics: [
        { label: 'Tuuli', value: windValue },
        // Temperature and dew point share a column, in the report's own
        // notation: a METAR writes them as one pair, 16/14, and a reader who
        // wants the spread wants them side by side anyway. It is also what
        // makes the row fit a phone — six columns need 379 px of the 342 a
        // 390 px screen has, and merging these two gives back 61 without
        // dropping a reading or shrinking a number.
        { label: 'Lämpö/kaste', value: tempPair(report.tempC, report.dewpC) },
        {
          // Kilometres from 5 km up, metres below it — which is how an aerodrome
          // states visibility anyway, and how the AIP and ATIS read: the metre
          // is the useful unit while it constrains you, and once it does not,
          // nobody cares about the last 400 m. 9999 in the report means "10 km
          // or more" and prints as 10 km, exactly as it is read aloud.
          //
          // It is also the narrow-screen fix: '10000 m' rendered 61 px wide in
          // a 57 px column on a 390 px phone and overlapped its neighbours.
          label: 'Näkyvyys',
          value: report.cavok ? 'CAVOK' : visibility(report.visM),
        },
        {
          label: 'Pilvet',
          value: report.ceilingFt === null
            ? (report.cavok ? 'ei estettä' : '–')
            : `${report.ceilingFt}\u2009ft`,
        },
        // No unit: QNH is hectopascals wherever this app is read, the label
        // already names the reading, and the four digits are unmistakable. The
        // unit was the widest part of the widest column.
        { label: 'QNH', value: Number.isFinite(report.qnhHpa) ? String(Math.round(report.qnhHpa)) : '–' },
      ],
    };
  }

  function markSelected(icao) {
    if (selectedIcao === icao) return;
    const previous = selectedIcao !== null && features.get(selectedIcao);
    if (previous) previous.set('selected', false);
    selectedIcao = icao;
    const next = icao !== null && features.get(icao);
    if (next) next.set('selected', true);
  }

  const clearSelection = () => markSelected(null);

  function selectFeature(feature) {
    markSelected(feature.get('icao'));
    const payload = payloadFor(feature);
    if (payload) telemetry.open(OWNER, payload, clearSelection);
  }

  // The strip has to follow the clock too: scrubbing to another frame changes
  // which report is current, and the panel must not keep showing the old one.
  function syncSelection() {
    if (selectedIcao === null || !telemetry) return;
    if (!telemetry.ownerIs(OWNER)) { clearSelection(); return; }
    const feature = features.get(selectedIcao);
    const payload = feature && payloadFor(feature);
    if (!payload) {
      clearSelection();
      telemetry.close(OWNER);
      return;
    }
    telemetry.update(OWNER, payload);
  }

  function attachPane(map, layer) {
    function findAtPixel(pixel) {
      if (!layer.getVisible()) return null;
      let hit = null;
      map.forEachFeatureAtPixel(pixel, (f, l) => {
        if (l === layer) { hit = f; return true; }
        return false;
      }, { hitTolerance: 10 });
      return hit;
    }
    return { findAtPixel, open: selectFeature };
  }

  return {
    styleLight,
    styleDark,
    attachPane,

    createPaneLayer() {
      return new VectorLayer({
        source,
        visible: false,
        maxResolution: MAX_RESOLUTION,
        // Own group so plot text never knocks out place names — layers sharing a
        // declutter value are decluttered together, topmost wins.
        declutter: 'metar',
        style: styleLight,
      });
    },

    // Called from the POI toggle: nothing is fetched while the layer is off.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        client.stop();
        source.clear(true);
        features.clear();
        syncSelection();
        return;
      }
      loadStations()
        .then(() => {
          if (!enabled) return;
          client.start([...positions.keys()], render);
        })
        .catch(() => { /* no positions means nothing to plot */ });
    },

    // Routed from setTime, beside the other clock-coupled POI layers.
    setCursor(timeMs) {
      if (timeMs === cursorMs) return;
      cursorMs = timeMs;
      render();
    },
  };
}
