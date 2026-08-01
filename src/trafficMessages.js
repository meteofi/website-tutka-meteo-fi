// Liikennetiedotteet — Fintraffic road traffic announcements from the
// Digitraffic Traffic message API (`tie.digitraffic.fi`, traffic-message v2).
// One announcement is one incident on the road network: accidents, closures,
// obstructions, ferry disruptions, changed traffic arrangements.
//
// Cross-pane pattern (same as placeNames/stormCells): ONE shared VectorSource,
// one VectorLayer per pane created through the paneDeps factory, so split
// screen costs no extra fetches. The drill-in card is per-pane (the radarSite.js
// pattern) — each pane owns an Overlay so a tap opens the card on the map the
// user tapped.
//
// CLOCK-COUPLED, like stormCells — but by filtering, not by fetching. The whole
// active set arrives in one response; `setCursor` then shows only the
// announcements whose validity spans the displayed frame. Scrubbing back an
// hour therefore hides an accident that had not happened yet at that frame, and
// reveals it exactly at the frame it started. Nothing is refetched on a cursor
// move; the filter is a timestamp compare over a handful of features.
//
// Server contract notes (measured against the live API on 2026-08-01):
//   * gzip is MANDATORY — a request without `Accept-Encoding: gzip` is answered
//     HTTP 406, not with an identity-encoded body. `fetch` always sends it, so
//     this only bites hand-rolled curl checks;
//   * `Digitraffic-User` identifies the app and is required by Digitraffic's
//     terms of use. It is an allowed CORS request header (the preflight is
//     cached 24 h), and `Access-Control-Allow-Origin` is `*`;
//   * responses carry `Cache-Control: max-age=60` + ETag, which is exactly the
//     poll interval below — a poll that lands inside the window is free;
//   * `from` returns announcements that were active after that instant,
//     INCLUDING ones that have already ended (they come back typed `ended` and
//     carry the real end time). That is what makes clock-coupling honest in
//     both directions rather than only hiding the future. `to`/`xMin…yMax` also
//     exist; a bbox is deliberately not used, since the set is small and a
//     view-dependent URL would defeat the 60 s cache for no gain;
//   * one feature per `situationId` — the latest version only, never a version
//     history (verified: 59 features, 59 distinct ids over a 72 h window). So
//     an `ended` feature REPLACES the live one it closes; it is not an extra
//     row to reconcile against;
//   * `announcements` is an array of language variants, but the schema pins
//     `language` to the single value `fi` — index 0 is the Finnish text, and
//     there is no other. Convenient here, since all UI text is Finnish anyway;
//   * `inactiveHours` / `includeAreaGeometry` belong to the DEPRECATED v1 API
//     (removed after 2026-10-20) and are HTTP 400 on v2. There is no way to ask
//     v2 to omit area geometry, so oversized area polygons must be handled
//     client-side — see AREA GEOMETRY below;
//   * geometry is `Point`, `LineString`, `MultiLineString` or `Polygon`
//     (MultiLineString dominates: 37 of 59 on the sampled window), and may be
//     null for an announcement whose location could not be resolved.
//
// AREA GEOMETRY. Announcements located by AlertC region carry a `Polygon` of
// the whole region — measured live, a 2021-vertex outline spanning all of
// Helsinki for a message whose actual subject was "Mäkelänkatu–Sturenkatu".
// The polygon is a coarse administrative proxy, not the incident's extent, so
// it is drawn as a thin dashed boundary with NO fill (a fill would smother the
// radar echo the user came for) and the marker is placed at the polygon's
// interior point rather than left implicit.
//
// TYPES. `trafficAnnouncementType` distinguishes accident reports from general
// announcements, but it says `ended` once a situation closes — which would
// erase the accident colouring exactly when scrubbing back to the accident is
// the interesting thing to do. The announcement's own `features[].name` tags
// survive that transition (10 of the sampled `ended` features still carry
// "Onnettomuus"), so the category is derived from the tags first and the type
// second. `retracted` is a withdrawn announcement — a false alarm — and is
// dropped outright rather than time-filtered.

import GeoJSON from 'ol/format/GeoJSON';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Overlay from 'ol/Overlay';
import {
  Circle as CircleStyle, Fill, RegularShape, Stroke, Style,
} from 'ol/style';

const API_URL = 'https://tie.digitraffic.fi/api/traffic-message/v2/traffic-announcements';

// Digitraffic's terms of use require identifying the app on every request. Same
// value the AIS client sends (src/ais/aisClient.js) — never anything personal.
const DIGITRAFFIC_USER = 'tutka.meteo.fi';

// Matches the response's own `Cache-Control: max-age=60`, so a poll either
// serves from the browser cache or picks up a genuinely new situation.
const REFRESH_MS = 60000;

// How far back announcements are requested. The animation window reaches one
// hour into the past, and an announcement that ended just before the oldest
// frame still has to be there to be filtered against it — so the request covers
// the window with margin rather than matching it exactly.
const HISTORY_MS = 2 * 60 * 60 * 1000;

// `from` is quantized onto a 5-minute grid (the animation step) so the URL is
// stable between polls instead of unique per request — the deterministic-URL
// rule the WMS layers follow, applied to a JSON API. Without this every poll
// would be a cache miss by construction.
const FROM_QUANTUM_MS = 5 * 60 * 1000;

// Tag matches that outrank `trafficAnnouncementType` when categorising. Matched
// case-insensitively as substrings, because the tag vocabulary is free-ish text
// from the sender ("Onnettomuus", "Tie on suljettu liikenteeltä", "Toinen
// ajorata on suljettu liikenteeltä", …).
const ACCIDENT_TAGS = ['onnettomuus'];
const WARNING_TAGS = ['suljettu', 'öljyä', 'esteenä', 'rikkoutunut'];

const ACCIDENT_TYPES = new Set(['preliminary accident report', 'accident report']);

// Marker geometry per category, so the layer is readable without colour alone:
// a triangle warns, a disc informs.
const PALETTES = {
  light: {
    halo: 'rgba(255,255,255,0.9)',
    category: {
      accident: '#c4003a',
      warning: '#b85c00',
      general: '#1c6ea4',
    },
  },
  dark: {
    halo: 'rgba(0,0,0,0.6)',
    category: {
      accident: '#ff2d55',
      warning: '#ffa033',
      general: '#5cb8f0',
    },
  },
};

// Drawn on top of whatever the marker sits on, so the glyph needs its own
// contrast rather than inheriting the basemap's.
const MARKER_RADIUS_PX = 8;
const LINE_WIDTH_PX = 4;

const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const timeText = (ms) => new Date(ms).toLocaleTimeString('fi', { hour: '2-digit', minute: '2-digit' });

const dateText = (ms) => new Date(ms).toLocaleDateString('fi', { day: 'numeric', month: 'numeric' });

// Start/end as one line. Same-day times are bare clock times; anything older
// than today carries its date, so a months-old roadworks notice does not read
// as if it started this morning.
function validityText(startMs, endMs) {
  const today = new Date();
  const isToday = (ms) => new Date(ms).toDateString() === today.toDateString();
  const stamp = (ms) => (isToday(ms) ? timeText(ms) : `${dateText(ms)} ${timeText(ms)}`);
  if (startMs === null && endMs === null) return '';
  if (startMs === null) return `päättyy ${stamp(endMs)}`;
  if (endMs === null) return `alkoi ${stamp(startMs)}`;
  return `${stamp(startMs)} – ${stamp(endMs)}`;
}

function categoryOf(type, tags) {
  const hay = tags.join(' ').toLowerCase();
  if (ACCIDENT_TAGS.some((t) => hay.includes(t)) || ACCIDENT_TYPES.has(type)) return 'accident';
  if (WARNING_TAGS.some((t) => hay.includes(t)) || type === 'unconfirmed observation') return 'warning';
  return 'general';
}

// Where the marker goes. Points speak for themselves; a line gets its midpoint
// so the marker sits ON the affected stretch rather than at an arbitrary end;
// a polygon gets `getInteriorPoint`, which is guaranteed inside a concave ring
// where a centroid is not.
function anchorOf(geometry) {
  if (!geometry) return null;
  const type = geometry.getType();
  if (type === 'Point') return geometry.getCoordinates();
  if (type === 'LineString') return geometry.getCoordinateAt(0.5);
  if (type === 'MultiLineString') {
    // The longest part carries the incident; the short ones are usually
    // slip roads hanging off it.
    const parts = geometry.getLineStrings();
    if (!parts.length) return null;
    const longest = parts.reduce((a, b) => (b.getLength() > a.getLength() ? b : a));
    return longest.getCoordinateAt(0.5);
  }
  if (type === 'Polygon') return geometry.getInteriorPoint().getCoordinates().slice(0, 2);
  if (type === 'MultiPolygon') {
    const pts = geometry.getInteriorPoints().getCoordinates();
    return pts.length ? pts[0].slice(0, 2) : null;
  }
  return null;
}

export default function initTrafficMessages() {
  const source = new VectorSource({
    attributions: 'Liikennetiedotteet © <a href="https://www.digitraffic.fi/">Fintraffic</a> (CC BY 4.0)',
  });

  const format = new GeoJSON({
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  });

  // Every announcement the last fetch returned, unfiltered. The clock filter
  // picks from this on each cursor move — refiltering a parsed array is far
  // cheaper than refetching, and the API has no per-frame query anyway.
  let all = [];
  // situationIds currently in the source, joined — the cheap "did the visible
  // set actually change" test that keeps cursor moves from clearing and
  // rebuilding the source 13 times a second during playback.
  let shownKey = null;
  let cursorMs = Date.now();
  let enabled = false;
  let timerId = 0;
  let fetchInFlight = null;
  let lastFetchMs = 0;
  // Per-pane cards, so a tap can be closed on the pane it was opened on.
  const cards = [];

  //
  // DATA
  //
  function parse(json) {
    const raw = (json.features || []).filter((f) => f.geometry);
    // Read geometry through the GeoJSON format so all four geometry types land
    // reprojected without a hand-rolled coordinate walk.
    const features = format.readFeatures({ type: 'FeatureCollection', features: raw });
    const out = [];
    features.forEach((feature, i) => {
      const props = raw[i].properties || {};
      const type = props.trafficAnnouncementType;
      // A retracted announcement never happened — it is not a situation that
      // ended, so no cursor position should show it.
      if (type === 'retracted') return;
      const a = (props.announcements || [])[0];
      if (!a) return;
      const tags = (a.features || []).map((f) => f.name).filter(Boolean);
      const td = a.timeAndDuration || {};
      const anchor = anchorOf(feature.getGeometry());
      if (!anchor) return;
      // Properties are flattened onto the feature rather than kept as the raw
      // nested announcement: the style function runs per render and the card
      // reads on tap, and neither should walk `announcements[0].locationDetails`.
      feature.setProperties({
        situationId: props.situationId,
        category: categoryOf(type, tags),
        announcementType: type,
        title: (a.title || '').trim(),
        description: ((a.location || {}).description || '').trim(),
        tags,
        sender: a.sender || '',
        comment: (a.comment || '').trim(),
        startMs: toMs(td.startTime),
        endMs: toMs(td.endTime),
        anchor,
      });
      out.push(feature);
    });
    return out;
  }

  // An announcement is on screen when the displayed frame falls inside its
  // validity. Missing bounds are open-ended rather than exclusive: a situation
  // with no start time is treated as having always been running (the API sends
  // this for long-lived notices), and no end time means still running.
  function isActiveAt(feature, ms) {
    const startMs = feature.get('startMs');
    const endMs = feature.get('endMs');
    if (startMs !== null && ms < startMs) return false;
    if (endMs !== null && ms > endMs) return false;
    return true;
  }

  function render() {
    const visible = all.filter((f) => isActiveAt(f, cursorMs));
    const key = visible.map((f) => f.get('situationId')).join(',');
    if (key === shownKey) return;
    shownKey = key;
    source.clear(true);
    if (visible.length) source.addFeatures(visible);
    // An open card outliving its marker is the failure mode this layer invites:
    // scrub the clock past an incident's end and the marker goes, but a card
    // anchored to it would hang over empty road. Close it with the marker.
    const ids = new Set(visible.map((f) => f.get('situationId')));
    cards.forEach((c) => c.syncVisible(ids));
  }

  function refresh() {
    if (fetchInFlight) return fetchInFlight;
    // Quantized so consecutive polls reuse one URL (and one cache entry)
    // instead of minting a fresh one every 60 s.
    const from = Math.floor((Date.now() - HISTORY_MS) / FROM_QUANTUM_MS) * FROM_QUANTUM_MS;
    const url = `${API_URL}?from=${encodeURIComponent(new Date(from).toISOString())}`;
    fetchInFlight = fetch(url, { headers: { 'Digitraffic-User': DIGITRAFFIC_USER } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        all = parse(json);
        lastFetchMs = Date.now();
        // The visible set is recomputed from scratch, so a situation that ended
        // between polls disappears without needing its own bookkeeping.
        shownKey = null;
        render();
      })
      .catch((err) => {
        // Offline / server hiccup: keep whatever is on screen (the
        // StickyImageWMS philosophy) and try again on the next tick.
        console.warn(`Liikennetiedotteet unavailable: ${err}`); // eslint-disable-line no-console
      })
      .finally(() => { fetchInFlight = null; });
    return fetchInFlight;
  }

  function stopPolling() {
    if (timerId) clearInterval(timerId);
    timerId = 0;
  }

  function startPolling() {
    stopPolling();
    timerId = setInterval(() => {
      // A hidden tab has nothing to show and its timers are throttled anyway;
      // the visibilitychange handler below catches up on return.
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!enabled || document.visibilityState !== 'visible') return;
    if (Date.now() - lastFetchMs >= REFRESH_MS) refresh();
  });

  //
  // STYLE
  //
  // One cached Style set per (theme, category); per-feature geometry is stamped
  // into the shared instances at render time — the stormCells/placeNames
  // pattern. Every stroke is drawn twice (wide halo underneath, colour on top)
  // so the mark separates from whatever radar echo is below it.
  function makeStyleFunction(theme) {
    const palette = PALETTES[theme];
    const cache = new Map();

    const styles = (category) => {
      let entry = cache.get(category);
      if (!entry) {
        const color = palette.category[category] || palette.category.general;
        const stroke = new Stroke({ color: palette.halo, width: LINE_WIDTH_PX + 3 });
        // Triangle warns, disc informs — so the categories stay apart for a
        // colour-blind reader and at a glance over busy imagery.
        const image = category === 'general'
          ? new CircleStyle({
            radius: MARKER_RADIUS_PX - 1,
            fill: new Fill({ color }),
            stroke: new Stroke({ color: palette.halo, width: 2 }),
          })
          : new RegularShape({
            points: 3,
            radius: MARKER_RADIUS_PX + 2,
            fill: new Fill({ color }),
            stroke: new Stroke({ color: palette.halo, width: 2 }),
          });
        entry = {
          lineHalo: new Style({ stroke }),
          line: new Style({ stroke: new Stroke({ color, width: LINE_WIDTH_PX }) }),
          // Area announcements are located by AlertC region, so the boundary is
          // drawn thin and dashed and never filled — it is a hint at scope, not
          // the incident's extent, and it sits over the weather.
          area: new Style({ stroke: new Stroke({ color, width: 1.5, lineDash: [6, 5] }) }),
          marker: new Style({ image }),
        };
        cache.set(category, entry);
      }
      return entry;
    };

    return (feature) => {
      const entry = styles(feature.get('category'));
      const geometry = feature.getGeometry();
      const type = geometry.getType();
      const out = [];
      if (type === 'LineString' || type === 'MultiLineString') {
        // The stretch of road is the real information for a line announcement —
        // draw it, then mark its middle.
        entry.lineHalo.setGeometry(geometry);
        entry.line.setGeometry(geometry);
        out.push(entry.lineHalo, entry.line);
      } else if (type === 'Polygon' || type === 'MultiPolygon') {
        entry.area.setGeometry(geometry);
        out.push(entry.area);
      }
      entry.marker.setGeometry(new Point(feature.get('anchor')));
      out.push(entry.marker);
      return out;
    };
  }

  const styleLight = makeStyleFunction('light');
  const styleDark = makeStyleFunction('dark');

  //
  // CARD
  //
  function buildCard() {
    const el = document.createElement('div');
    el.className = 'marker-card traffic-card';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Liikennetiedote');
    el.innerHTML = `
      <div class="marker-card-head">
        <i class="material-icons marker-card-icon" aria-hidden="true">warning</i>
        <span class="marker-card-title">Liikennetiedote</span>
        <button type="button" class="marker-card-close" aria-label="Sulje">
          <i class="material-icons" aria-hidden="true">close</i>
        </button>
      </div>
      <div class="traffic-card-body">
        <div class="traffic-card-tag"></div>
        <div class="traffic-card-title"></div>
        <div class="traffic-card-desc"></div>
        <div class="traffic-card-time"></div>
      </div>
    `;
    return el;
  }

  // One card per pane (the radarSite.js pattern): the Overlay belongs to a
  // single map, so a shared card would jump between panes in split screen.
  function attachPane(map, layer) {
    const el = buildCard();
    document.body.appendChild(el);
    const overlay = new Overlay({
      element: el,
      positioning: 'bottom-center',
      offset: [0, -18],
      stopEvent: true,
      autoPan: { animation: { duration: 250 }, margin: 20 },
    });
    map.addOverlay(overlay);

    const tagEl = el.querySelector('.traffic-card-tag');
    const titleEl = el.querySelector('.traffic-card-title');
    const descEl = el.querySelector('.traffic-card-desc');
    const timeEl = el.querySelector('.traffic-card-time');

    // The situationId this card is showing, or null when closed — the handle
    // for closing it again when its announcement leaves the displayed frame.
    let openId = null;

    function hide() {
      openId = null;
      overlay.setPosition(undefined);
    }

    el.querySelector('.marker-card-close').addEventListener('click', (e) => {
      e.stopPropagation();
      hide();
    });

    // Hit-test against THIS pane's traffic layer only, so a tap does not open
    // the card for a radar site or an airfield sitting under the same pixel.
    // hitTolerance enlarges the tap target around the small marker without
    // changing how it is drawn.
    function findAtPixel(pixel) {
      if (!layer.getVisible()) return null;
      let hit = null;
      map.forEachFeatureAtPixel(pixel, (f, l) => {
        if (l === layer) { hit = f; return true; }
        return false;
      }, { hitTolerance: 10 });
      return hit;
    }

    function openFor(feature) {
      // The tag line names the incident ("Onnettomuus"); the title repeats the
      // road and municipality, so the tags carry what the title does not.
      const tags = feature.get('tags');
      tagEl.textContent = tags.join(' · ');
      tagEl.hidden = !tags.length;
      tagEl.className = `traffic-card-tag traffic-${feature.get('category')}`;
      titleEl.textContent = feature.get('title');
      const desc = feature.get('description');
      const comment = feature.get('comment');
      descEl.textContent = [desc, comment].filter(Boolean).join('\n');
      descEl.hidden = !descEl.textContent;
      timeEl.textContent = validityText(feature.get('startMs'), feature.get('endMs'));
      timeEl.hidden = !timeEl.textContent;
      openId = feature.get('situationId');
      overlay.setPosition(feature.get('anchor'));
    }

    // Close the card when the announcement it shows is no longer on the
    // displayed frame (clock scrubbed past its end, or the poll dropped it).
    function syncVisible(ids) {
      if (openId !== null && !ids.has(openId)) hide();
    }

    const handle = {
      findAtPixel, openFor, hide, syncVisible,
    };
    cards.push(handle);
    return handle;
  }

  return {
    styleLight,
    styleDark,
    attachPane,

    // Pane factory for paneDeps. Starts hidden and on the light style; POI
    // visibility and setMapLayer take over immediately after pane creation.
    createPaneLayer() {
      return new VectorLayer({
        source,
        visible: false,
        style: styleLight,
      });
    },

    // Called from the POI toggle: fetching and polling only run while the layer
    // is actually on.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        stopPolling();
        cards.forEach((c) => c.hide());
        return;
      }
      if (Date.now() - lastFetchMs >= REFRESH_MS) refresh();
      startPolling();
      render();
    },

    // Routed from setTime (radar.js) on every clock move — same signature as
    // probe/crossSection/stormCells. Only the cursor matters here (the whole
    // active set is already in memory), but the signature stays uniform so the
    // call site reads like its neighbours.
    setCursor(timeMs) {
      if (timeMs === cursorMs) return;
      cursorMs = timeMs;
      if (!enabled) return;
      render();
    },
  };
}
