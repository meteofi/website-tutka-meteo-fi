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
// issues a METAR at all come from the bundled eAIP snapshot
// (src/data/airfields-finland.geojson), which is why this layer is 200 lines
// rather than 400. The generator reads the last of those from AD 2.11 — the
// aerodrome's associated MET office, or NIL — which is an exact predictor: the
// 24 aerodromes with a named office are precisely the 24 that answer.
//
// So only those are ever asked for. The alternative, asking all 80 and keeping
// whoever replies, works too but spends the first request on 56 aerodromes that
// have no weather service and never will.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';

import airfieldsUrl from '../data/airfields-finland.geojson';
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

// Does this snapshot carry the METAR flag at all? Cached per load, since the
// answer cannot change within one.
let flaggedKnown = null;
function anyFlagged(json) {
  if (flaggedKnown === null) {
    flaggedKnown = (json.features || []).some((f) => f.properties && f.properties.metar);
  }
  return flaggedKnown;
}

export default function initMetar({ telemetry } = {}) {
  const source = new VectorSource({
    attributions: 'METAR © <a href="https://www.met.no/">MET Norway</a> (CC BY 4.0)',
  });
  const features = new Map(); // icao -> Feature
  const positions = new Map(); // icao -> map coordinates
  const client = createMetarSource();

  let enabled = false;
  let cursorMs = Date.now();
  let stationsLoaded = false;

  // The aerodrome positions, from the bundle the eAIP generator produces. Every
  // station that reports METAR is in here; the ones that are not simply never
  // get a feature.
  async function loadStations() {
    if (stationsLoaded) return;
    const resp = await fetch(airfieldsUrl);
    const json = await resp.json();
    (json.features || []).forEach((f) => {
      const { icao, metar } = f.properties;
      // `metar` is set only on aerodromes with a MET office. An older snapshot
      // predates the flag, so falling back to every aerodrome keeps the layer
      // working rather than drawing nothing at all — the source narrows to the
      // repliers on its next refresh either way.
      if (icao && f.geometry && (metar || !anyFlagged(json))) {
        positions.set(icao, fromLonLat(f.geometry.coordinates));
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

  const fmt = (v, unit, digits = 0) => (Number.isFinite(v) ? `${v.toFixed(digits)}\u2009${unit}` : '–');

  function payloadFor(feature) {
    const report = feature.get('report');
    if (!report) return null;
    const { wind } = report;
    let windValue = '–';
    if (wind) {
      if (wind.calm) windValue = 'tyyni';
      else if (wind.variable) windValue = `VRB ${Math.round(wind.speedKt)}\u2009kt`;
      else {
        const gust = Number.isFinite(wind.gustKt) ? `\u2009(${Math.round(wind.gustKt)})` : '';
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
        { label: 'Lämpötila', value: fmt(report.tempC, '°C') },
        { label: 'Kastepiste', value: fmt(report.dewpC, '°C') },
        {
          label: 'Näkyvyys',
          value: report.cavok ? 'CAVOK' : fmt(report.visM, 'm'),
        },
        {
          label: 'Pilvet',
          value: report.ceilingFt === null
            ? (report.cavok ? 'ei estettä' : '–')
            : `${report.ceilingFt}\u2009ft`,
        },
        { label: 'QNH', value: fmt(report.qnhHpa, 'hPa') },
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
