// Kelikamerat — Fintraffic road weather cameras from the Digitraffic Weathercam
// API (`tie.digitraffic.fi/api/weathercam/v1`). 812 fixed camera stations along
// the Finnish road network, each with 1–7 presets (camera directions).
//
// Markers use the shared-source / per-pane-layer pattern (placeNames,
// stormCells, trafficMessages) so split screen costs no extra fetches. The image
// panel is a SINGLE global instance — the bottom-panel pattern of
// crossSection.js / probe.js, opened by a marker tap in any pane.
//
// CLOCK-COUPLED IMAGES. This is the point of the layer. Every station exposes
// 24 h of history at an exact 10-minute cadence with per-version image URLs, so
// the photo on screen is the one the camera actually held at the displayed
// frame's instant: scrub back through the hour and the road goes from dry to wet
// as the radar's rain band crosses it. A camera pinned to "now" would contradict
// the frame the user is looking at.
//
// The markers themselves are NOT clock-coupled — they are fixed installations,
// wall-clock static like the radar sites.
//
// Server contract notes (measured against the live API on 2026-08-02):
//   * gzip is MANDATORY across the whole tie.digitraffic.fi API — a request
//     without `Accept-Encoding: gzip` is answered HTTP 406, not identity-encoded.
//     `fetch` always sends it; this only bites hand-rolled curl checks;
//   * `/stations` is 812 features / 37 kB gzipped and near-static, so it is
//     fetched once rather than polled. Its `name` is a SLUG (`kt51_Inkoo`); the
//     presentable name (`names.fi` = "Tie 51 Inkoo") exists only on
//     `/stations/{id}`, which is why markers carry no labels and the panel
//     fetches detail on open;
//   * `/stations/{id}/history` is ~16 kB gzipped: 144 entries per preset, ascending,
//     at an exact 10-minute cadence spanning 23.8 h. Each entry's `imageUrl`
//     already carries `?versionId=…`, and `&thumbnail=true` composes with it —
//     which is what makes following the clock affordable (18 kB per frame
//     against 260 kB for the full image);
//   * IMAGES CARRY NO `Access-Control-Allow-Origin`. They must stay in a DOM
//     `<img>`; drawing one into a canvas would taint it permanently and break
//     `share.js` (see the crossOrigin note in pane.js). This is why the panel is
//     HTML rather than anything canvas-based, and it is not negotiable;
//   * 4 of 812 stations are `REMOVED_TEMPORARILY` rather than `GATHERING`, and
//     12 of 2275 presets are `inCollection: false` — both are filtered out;
//   * some presets' newest image is years old, so "no recent image" is a real
//     state the panel has to render rather than an error.

import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';
import {
  Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text,
} from 'ol/style';
import { bearingForDirection, fetchRoadTangent } from './roadBearing';

const API = 'https://tie.digitraffic.fi/api/weathercam/v1';

// View cone for the open camera's active direction. Sized in pixels so it reads
// the same at every zoom, and drawn wide (2 x this half-angle) because it is a
// road bearing, not a lens frustum — the API publishes no field of view, so a
// narrow ray would claim precision that does not exist.
const CONE_LENGTH_PX = 38;
const CONE_HALF_DEG = 21;

// Digitraffic's terms of use require identifying the app on every request. Same
// value the AIS and traffic-announcement clients send — never anything personal.
const DIGITRAFFIC_USER = 'tutka.meteo.fi';

// The station list is effectively static (new cameras appear a few times a
// year), so it is fetched once and only refreshed if the layer is switched back
// on much later. Nothing here polls.
const STATIONS_MAX_AGE_MS = 30 * 60 * 1000;

// Markers disappear below this resolution (m/px in EPSG:3857) — ~z7, one zoom
// step wider than the z8 band stormCells.js uses, so a region-level view still
// shows its cameras. Declutter thins the marks that would otherwise pile up at
// this scale; below it 812 cameras become a wall over the weather.
const MAX_RESOLUTION = 1400;

// History is a 10-minute grid while the animation steps 5 minutes, so
// consecutive frames often resolve to the same image. An image older than this
// relative to the cursor means the camera has stopped updating; the panel says
// so rather than showing a stale photo as if it were current.
const MAX_IMAGE_AGE_MS = 45 * 60 * 1000;

// Window prefetch, the crossSection.js shape: the displayed frame first, then
// outward, a small cap so the frame the user is waiting for is never queued
// behind a dozen speculative loads.
const MAX_PRELOAD_IN_FLIGHT = 3;

const PALETTES = {
  light: {
    body: '#1c4f7c',
    halo: 'rgba(255,255,255,0.9)',
    // The open station's mark. The app's primary cyan reads as "active"
    // everywhere else in the UI, so it needs no separate legend.
    accent: '#0089c4',
    cone: 'rgba(0,137,196,0.22)',
    textFill: '#123044',
    textHalo: '#ffffff',
  },
  dark: {
    body: '#7fc4f5',
    halo: 'rgba(0,0,0,0.6)',
    accent: '#12bcfa',
    cone: 'rgba(18,188,250,0.20)',
    textFill: '#eaf6ff',
    textHalo: '#000000',
  },
};

const timeText = (ms) => new Date(ms).toLocaleTimeString('fi', { hour: '2-digit', minute: '2-digit' });

const toRadians = (deg) => (deg * Math.PI) / 180;

// Thumbnails everywhere: 384x216 at 14 kB against 1280x720 at 251 kB. The panel
// is ~390 px wide on a phone, so the thumbnail is close to 1:1 — and following
// the clock at full resolution would cost a quarter-megabyte per frame.
function thumbUrl(imageUrl) {
  return `${imageUrl}${imageUrl.includes('?') ? '&' : '?'}thumbnail=true`;
}

// Wedge from the camera along `bearingDeg`, in map units. Web Mercator is
// conformal with vertical meridians, so a true bearing is already the grid
// bearing here — the only conversion is compass (clockwise from north) to the
// maths convention (counter-clockwise from +x).
function coneGeometry(center, bearingDeg, resolution) {
  const radius = CONE_LENGTH_PX * resolution;
  const a0 = toRadians(90 - bearingDeg - CONE_HALF_DEG);
  const a1 = toRadians(90 - bearingDeg + CONE_HALF_DEG);
  const ring = [center];
  const STEPS = 8;
  for (let i = 0; i <= STEPS; i++) {
    const a = a0 + ((a1 - a0) * i) / STEPS;
    ring.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]);
  }
  ring.push(center);
  return new Polygon([ring]);
}

function fetchJson(url) {
  return fetch(url, { headers: { 'Digitraffic-User': DIGITRAFFIC_USER } })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
}

// Newest entry at or before `ms` — the image the camera actually held at that
// instant. Entries are ascending (verified live), so this is a plain scan back
// from the end; 144 entries makes anything cleverer pointless.
function entryAt(history, ms) {
  if (!history.length) return null;
  if (ms >= history[history.length - 1].atMs) return history[history.length - 1];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].atMs <= ms) return history[i];
  }
  // Cursor older than everything retained: the oldest image is the closest
  // truthful answer, and its own timestamp label makes the gap visible.
  return history[0];
}

export default function initWeatherCameras({ container } = {}) {
  const source = new VectorSource({
    attributions: 'Kelikamerat © <a href="https://www.digitraffic.fi/">Fintraffic</a> (CC BY 4.0)',
  });

  let stationsAt = 0;
  let stationsInFlight = null;
  let enabled = false;
  let cursorMs = Date.now();

  // stationId -> { name, presets: [{ id, label, history: [{atMs, url}] }] }
  const details = new Map();
  const detailInFlight = new Map();
  // stationId -> road tangent in degrees, or null when it could not be resolved
  const tangents = new Map();
  const tangentInFlight = new Map();

  //
  // MARKERS
  //
  function loadStations() {
    if (stationsInFlight) return stationsInFlight;
    if (source.getFeatures().length && Date.now() - stationsAt < STATIONS_MAX_AGE_MS) {
      return Promise.resolve();
    }
    stationsInFlight = fetchJson(`${API}/stations`)
      .then((json) => {
        const features = (json.features || [])
          // REMOVED_TEMPORARILY cameras are not producing images; a marker for
          // one is a tap that can only disappoint.
          .filter((f) => f.geometry && f.properties
            && f.properties.collectionStatus === 'GATHERING'
            && (f.properties.presets || []).some((p) => p.inCollection))
          .map((f) => {
            const [lon, lat] = f.geometry.coordinates;
            const feature = new Feature({ geometry: new Point(fromLonLat([lon, lat])) });
            feature.setProperties({
              stationId: f.properties.id,
              // The list endpoint's `name` is a slug, so it is kept only as a
              // fallback for the panel head while the detail fetch is in flight.
              slug: f.properties.name || '',
            });
            return feature;
          });
        source.clear(true);
        source.addFeatures(features);
        stationsAt = Date.now();
      })
      .catch((err) => {
        console.warn(`Kelikamerat unavailable: ${err}`); // eslint-disable-line no-console
      })
      .finally(() => { stationsInFlight = null; });
    return stationsInFlight;
  }

  function makeStyleFunction(theme) {
    const palette = PALETTES[theme];
    // A squat rectangle with a lens dot: reads as a camera at marker size, and
    // stays distinct from the traffic layer's triangle/disc and the radar
    // sites' own mark. Drawn shapes rather than an icon asset, matching every
    // other POI here (turnpointStyle, icaoStyle).
    const body = new Style({
      image: new RegularShape({
        points: 4,
        radius: 6.5,
        angle: Math.PI / 4,
        fill: new Fill({ color: palette.body }),
        stroke: new Stroke({ color: palette.halo, width: 2 }),
      }),
    });
    const lens = new Style({
      image: new RegularShape({
        points: 4,
        radius: 2.2,
        angle: Math.PI / 4,
        fill: new Fill({ color: palette.halo }),
      }),
    });

    // The station whose photo is open. Without this the panel gives no clue
    // which of 800-odd marks it belongs to — the whole point of tapping one on
    // a map is knowing where you are looking from.
    //
    // Every part of the highlight is `declutterMode: 'none'`. The layer
    // declutters to thin the marks out at wide zoom, but decluttering applies
    // per style: the ring overlaps the body and the label overlaps both, so the
    // collision pass silently dropped all but the halo ring and left the
    // selection nearly invisible. There is only ever one selected station, so
    // exempting it costs nothing and it must never be thinned away.
    const selBody = new Style({
      image: new RegularShape({
        points: 4,
        radius: 7.5,
        angle: Math.PI / 4,
        fill: new Fill({ color: palette.accent }),
        stroke: new Stroke({ color: palette.halo, width: 2 }),
        declutterMode: 'none',
      }),
    });
    const selRing = new Style({
      image: new CircleStyle({
        radius: 13,
        fill: null,
        stroke: new Stroke({ color: palette.accent, width: 2 }),
        declutterMode: 'none',
      }),
    });
    const selRingHalo = new Style({
      image: new CircleStyle({
        radius: 13,
        fill: null,
        stroke: new Stroke({ color: palette.halo, width: 4 }),
        declutterMode: 'none',
      }),
    });
    // The view direction as the operator words it ("Poriin", "Tienpinta") —
    // straight from the API. The Digitraffic preset carries no azimuth, only a
    // road-register direction enum, so nothing here draws a bearing it cannot
    // actually know.
    const selLabel = new Style({
      text: new Text({
        font: '600 12px Roboto, sans-serif',
        fill: new Fill({ color: palette.textFill }),
        stroke: new Stroke({ color: palette.textHalo, width: 3 }),
        offsetY: -22,
        declutterMode: 'none',
      }),
    });

    // Where the camera is pointed, derived from the road's own geometry (see
    // roadBearing.js). Drawn under the marker so the mark stays legible, and
    // filled faintly so it reads as an annotation over the radar echo rather
    // than as data of its own.
    const cone = new Style({
      fill: new Fill({ color: palette.cone }),
      stroke: new Stroke({ color: palette.accent, width: 1.5 }),
    });

    return (feature, resolution) => {
      if (!feature.get('selected')) return [body, lens];
      const out = [];
      const bearing = feature.get('viewBearing');
      if (Number.isFinite(bearing)) {
        const at = feature.getGeometry().getCoordinates();
        cone.setGeometry(coneGeometry(at, bearing, resolution));
        out.push(cone);
      }
      out.push(selRingHalo, selRing, selBody);
      const label = feature.get('dirLabel');
      if (label) {
        selLabel.getText().setText(label);
        out.push(selLabel);
      }
      return out;
    };
  }

  const styleLight = makeStyleFunction('light');
  const styleDark = makeStyleFunction('dark');

  //
  // DETAIL + HISTORY
  //
  // One fetch pair per opened station, cached for the session: the detail gives
  // the presentable name and the preset labels, the history gives the versioned
  // image URLs the clock snaps across.
  function loadStation(stationId) {
    if (details.has(stationId)) return Promise.resolve(details.get(stationId));
    if (detailInFlight.has(stationId)) return detailInFlight.get(stationId);
    const p = Promise.all([
      fetchJson(`${API}/stations/${stationId}`),
      fetchJson(`${API}/stations/${stationId}/history`),
    ]).then(([detail, history]) => {
      const props = detail.properties || {};
      const historyById = new Map();
      (history.presets || []).forEach((hp) => {
        const entries = (hp.history || [])
          .map((h) => ({ atMs: Date.parse(h.lastModified), url: h.imageUrl }))
          .filter((h) => Number.isFinite(h.atMs))
          .sort((a, b) => a.atMs - b.atMs);
        historyById.set(hp.id, entries);
      });
      const presets = (props.presets || [])
        .filter((pr) => pr.inCollection)
        .map((pr) => ({
          id: pr.id,
          // presentationName is the direction as the operator words it
          // ("Inkooseen", "Tienpinta"); it is what a road user recognises.
          label: pr.presentationName || pr.id,
          // Road-register direction, turned into a real bearing against the
          // road geometry once the tangent lands (see roadBearing.js).
          direction: pr.direction,
          history: historyById.get(pr.id) || [],
        }))
        // A preset with no history at all has nothing to show on any frame.
        .filter((pr) => pr.history.length);
      const entry = {
        name: (props.names && props.names.fi) || props.name || stationId,
        municipality: props.municipality || '',
        // Kept for the road-tangent lookup, which needs the camera's own road
        // address and position to resolve a bearing.
        roadAddress: props.roadAddress || null,
        lonLat: (detail.geometry && detail.geometry.coordinates)
          ? detail.geometry.coordinates.slice(0, 2) : null,
        tangent: null,
        presets,
      };
      details.set(stationId, entry);
      return entry;
    }).catch((err) => {
      console.warn(`Kelikamera ${stationId} unavailable: ${err}`); // eslint-disable-line no-console
      return null;
    }).finally(() => { detailInFlight.delete(stationId); });
    detailInFlight.set(stationId, p);
    return p;
  }

  //
  // PANEL
  //
  // Bottom panel, the crossSection.js/probe.js pattern: `hidden` is removed once
  // at build time and the height-0 / `.open` CSS transition does the show/hide.
  let panel = null;
  if (container) {
    container.removeAttribute('hidden');
    container.removeAttribute('aria-hidden');
    container.innerHTML = `
      <div class="camera-head">
        <i class="material-icons camera-icon" aria-hidden="true">photo_camera</i>
        <span class="camera-title"></span>
        <span class="camera-time"></span>
        <button type="button" class="camera-close" aria-label="Sulje kelikamera">
          <i class="material-icons" aria-hidden="true">close</i>
        </button>
      </div>
      <div class="camera-body">
        <img class="camera-image" alt="" decoding="async">
        <div class="camera-message" hidden></div>
      </div>
      <div class="camera-presets" role="group" aria-label="Suunta"></div>
    `;
    panel = {
      el: container,
      title: container.querySelector('.camera-title'),
      time: container.querySelector('.camera-time'),
      image: container.querySelector('.camera-image'),
      message: container.querySelector('.camera-message'),
      presets: container.querySelector('.camera-presets'),
    };
  }

  let station = null; // the open station's detail entry
  let stationId = null;
  let selectedFeature = null; // the marker the panel belongs to
  let activePreset = null;
  let shownUrl = null;
  // Generation guard: a station or preset change invalidates images still
  // decoding, so a slow load from the previous camera can never paint over the
  // new one. Cursor moves deliberately do NOT bump it — an in-flight image for
  // a frame the user just left is still worth keeping for the cache.
  let generation = 0;
  const preloaded = new Set();
  let preloadQueue = [];
  let preloadInFlight = 0;

  // Selection lives on the feature itself, so every pane's layer repaints from
  // the one shared source — no per-pane overlay bookkeeping. `set` fires a
  // change event the source forwards to the layers, so no explicit redraw.
  function setSelected(feature) {
    if (selectedFeature === feature) return;
    if (selectedFeature) {
      selectedFeature.set('selected', false);
      selectedFeature.set('dirLabel', '');
      selectedFeature.set('viewBearing', undefined);
    }
    selectedFeature = feature;
    if (feature) feature.set('selected', true);
  }

  // The direction label under the highlighted marker follows the chosen preset.
  function updateDirLabel() {
    if (selectedFeature) selectedFeature.set('dirLabel', activePreset ? activePreset.label : '');
  }

  // The view cone. Absent until the road tangent has been resolved, and absent
  // for good on presets whose direction is not along this road (road-surface
  // and scenery views, crossing roads, unrecorded) — those simply get no cone
  // rather than a guessed one.
  function updateViewBearing() {
    if (!selectedFeature) return;
    const bearing = bearingForDirection(
      station ? station.tangent : null,
      activePreset ? activePreset.direction : null,
    );
    selectedFeature.set('viewBearing', Number.isFinite(bearing) ? bearing : undefined);
  }

  // One road-section lookup per station, cached for the session. It resolves
  // after the panel is already showing its photo — the cone appearing a moment
  // later is better than holding the image back for it.
  function loadTangent(id, entry) {
    if (tangents.has(id)) return Promise.resolve(tangents.get(id));
    if (tangentInFlight.has(id)) return tangentInFlight.get(id);
    const p = fetchRoadTangent(entry.roadAddress, entry.lonLat)
      .then((t) => { tangents.set(id, t); return t; })
      .finally(() => { tangentInFlight.delete(id); });
    tangentInFlight.set(id, p);
    return p;
  }

  function setMessage(text) {
    if (!panel) return;
    panel.message.textContent = text || '';
    panel.message.hidden = !text;
    panel.image.classList.toggle('empty', !!text);
  }

  function startPreload(url) {
    preloaded.add(url);
    preloadInFlight += 1;
    const img = new Image();
    // Success and failure both just free the slot: a preload is a cache warm,
    // so a broken frame is not worth reporting anywhere.
    const done = () => { preloadInFlight -= 1; pump(); };
    img.onload = done;
    img.onerror = done;
    img.src = url;
  }

  function pump() {
    while (preloadInFlight < MAX_PRELOAD_IN_FLIGHT && preloadQueue.length) {
      const url = preloadQueue.shift();
      if (!preloaded.has(url)) startPreload(url);
    }
  }

  // Warm the browser cache for the frames around the cursor so scrubbing and
  // playback do not stall on a fetch per step. Displayed frame first, then
  // outward — the crossSection.js ordering.
  function preloadWindow(windowStartMs, stepMs) {
    if (!activePreset || !Number.isFinite(windowStartMs) || !Number.isFinite(stepMs)) return;
    const wanted = [];
    for (let i = 0; i < 13; i++) {
      const e = entryAt(activePreset.history, windowStartMs + i * stepMs);
      if (e) wanted.push({ url: thumbUrl(e.url), d: Math.abs(windowStartMs + i * stepMs - cursorMs) });
    }
    wanted.sort((a, b) => a.d - b.d);
    preloadQueue = wanted.map((w) => w.url).filter((u, i, all) => all.indexOf(u) === i && !preloaded.has(u));
    pump();
  }

  // Paint the image for the current cursor. The previous photo stays up until
  // the new one has decoded (the StickyImageWMS rule the raster layers follow),
  // so playback never flashes an empty panel.
  function renderImage() {
    if (!panel || !activePreset) return;
    const entry = entryAt(activePreset.history, cursorMs);
    if (!entry) {
      setMessage('Ei kuvaa saatavilla');
      return;
    }
    panel.time.textContent = timeText(entry.atMs);
    // The cursor can sit far from any retained image (a dead camera, or a frame
    // older than the 24 h history). Saying so beats presenting an old photo as
    // if it belonged to the frame on screen.
    if (Math.abs(cursorMs - entry.atMs) > MAX_IMAGE_AGE_MS) {
      setMessage(`Ei kuvaa tältä hetkeltä — viimeisin ${timeText(entry.atMs)}`);
      return;
    }
    setMessage('');
    const url = thumbUrl(entry.url);
    if (url === shownUrl) return;
    shownUrl = url;
    const gen = generation;
    const img = new Image();
    img.onload = () => {
      if (gen !== generation || shownUrl !== url) return;
      panel.image.src = url;
    };
    img.onerror = () => {
      if (gen !== generation || shownUrl !== url) return;
      setMessage('Kuvaa ei voitu ladata');
    };
    img.src = url;
    preloaded.add(url);
  }

  function renderPresets() {
    if (!panel) return;
    panel.presets.textContent = '';
    const list = station ? station.presets : [];
    // A single-direction camera needs no selector; the row collapses so the
    // image gets the height instead.
    panel.presets.hidden = list.length < 2;
    list.forEach((preset) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'camera-preset';
      btn.textContent = preset.label;
      btn.setAttribute('aria-pressed', String(preset === activePreset));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (preset === activePreset) return;
        activePreset = preset;
        generation += 1;
        shownUrl = null;
        updateDirLabel();
        updateViewBearing();
        renderPresets();
        renderImage();
      });
      panel.presets.appendChild(btn);
    });
  }

  function close() {
    if (!panel) return;
    generation += 1;
    setSelected(null);
    station = null;
    stationId = null;
    activePreset = null;
    shownUrl = null;
    preloadQueue = [];
    panel.el.classList.remove('open');
  }

  if (panel) {
    container.querySelector('.camera-close').addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
  }

  function open(feature) {
    if (!panel) return;
    const id = feature.get('stationId');
    // Re-tapping the camera that is already open must not reset the panel back
    // to its loading state and drop the preset the user picked.
    if (id === stationId && station) return;
    generation += 1;
    const gen = generation;
    stationId = id;
    station = null;
    activePreset = null;
    shownUrl = null;
    // Highlight immediately, before the detail fetch resolves — the tap should
    // acknowledge itself on the map without waiting on the network.
    setSelected(feature);
    panel.el.classList.add('open');
    panel.title.textContent = feature.get('slug') || id;
    panel.time.textContent = '';
    panel.image.removeAttribute('src');
    panel.presets.hidden = true;
    setMessage('Ladataan…');
    loadStation(id).then((entry) => {
      if (gen !== generation) return;
      if (!entry || !entry.presets.length) {
        setMessage('Ei kuvaa saatavilla');
        return;
      }
      station = entry;
      [activePreset] = entry.presets;
      panel.title.textContent = entry.name;
      setMessage('');
      updateDirLabel();
      updateViewBearing();
      renderPresets();
      renderImage();
      // The cone trails the photo: the road lookup is a second request, and the
      // image is what the user tapped for.
      loadTangent(id, entry).then((t) => {
        if (gen !== generation) return;
        entry.tangent = t;
        updateViewBearing();
      });
    });
  }

  //
  // PUBLIC API
  //
  function attachPane(map, layer) {
    // Hit-test against THIS pane's camera layer only, so a tap does not open the
    // panel for a radar site or a traffic marker under the same pixel.
    // hitTolerance enlarges the tap target without changing how it is drawn.
    function findAtPixel(pixel) {
      if (!layer.getVisible()) return null;
      let hit = null;
      map.forEachFeatureAtPixel(pixel, (f, l) => {
        if (l === layer) { hit = f; return true; }
        return false;
      }, { hitTolerance: 10 });
      return hit;
    }
    return { findAtPixel, open };
  }

  return {
    styleLight,
    styleDark,
    attachPane,
    close,

    // Pane factory for paneDeps. Starts hidden and on the light style; POI
    // visibility and setMapLayer take over immediately after pane creation.
    createPaneLayer() {
      return new VectorLayer({
        source,
        visible: false,
        // 812 fixed marks: hidden at synoptic zoom, and decluttered in their own
        // group above it. Sharing a declutter value would let these marks erase
        // a lower layer's labels (the CLAUDE.md place-names warning).
        maxResolution: MAX_RESOLUTION,
        declutter: 'weather-cameras',
        style: styleLight,
      });
    },

    // Called from the POI toggle: the station list is fetched only once the
    // layer is actually switched on.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        close();
        return;
      }
      loadStations();
    },

    // Routed from setTime (radar.js) on every clock move — the same signature as
    // probe/crossSection/stormCells/trafficMessages. Only matters while a
    // station is open; the markers themselves are wall-clock static.
    setCursor(timeMs, windowStartMs, stepMs) {
      const moved = timeMs !== cursorMs;
      cursorMs = timeMs;
      if (!activePreset) return;
      if (moved) renderImage();
      preloadWindow(windowStartMs, stepMs);
    },
  };
}
