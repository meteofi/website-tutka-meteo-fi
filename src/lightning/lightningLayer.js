// Client-rendered FMI lightning layer (EDR-backed) with a WMS companion —
// PR D of the lightning WMS→EDR migration.
//
// The lightning category is dual-backend: the FMI product
// (`observation:lightning` — the id survives from the dead wms-obs GeoServer
// so persistence/canonical URLs need no migration) renders client-side from
// the EDR fmi-lightning collection, while the EUMETSAT products (li_afa,
// rdt) stay WMS rasters animated through FramePool. This controller owns
// both faces:
//
//   - `layerss.lightningLayer` is the EDR VectorLayer with the same
//     WMS-param facade the obs layer uses (getParams/updateParams LAYERS +
//     no-op setLayerUrl) — it carries the category identity: visibility
//     toggles, menus, ACTIVE_LAYERS persistence, canonical page, playlist.
//   - A per-pane COMPANION ImageWMS layer (name `lightningWmsLayer`, not in
//     layerss) renders li_afa/rdt with its own FramePool. Product switches
//     route through the facade: EDR id → companion hidden, strikes shown;
//     WMS id → strikes hidden, companion shown and radar.js applies the
//     normal WMS param/url update to it via the injected onWmsProduct.
//
// Clock contract (same as the obs controller): radar.js setTime calls
// route(windowStartMs, stepMs, cursorMs) each tick. Per frame t the style
// shows strikes with strike.t ∈ (t − step, t] — exactly the accumulation
// interval the WMS raster rendered as TIME=PT{n}M/{t}. The NEWEST frame's
// slice is open-ended so strikes from the live poll (45 s newestSeen→now
// top-up) appear immediately, instead of waiting for the radar-lagged
// window end.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { fromLonLat, toLonLat } from 'ol/proj';
import { RegularShape, Stroke, Style } from 'ol/style';
import { createLightningClient } from './edrLightning';

const FRAME_COUNT = 13;
const MOVE_DEBOUNCE_MS = 300;
const LIVE_POLL_MS = 45000;

// Products this controller renders itself; every other id on the lightning
// menu is a WMS raster for the companion layer.
const EDR_PRODUCTS = new Set(['observation:lightning']);

//
// Strike symbology (approved design): an ×-cross in lightning yellow with a
// dark halo, sized by |peak_current| in the FMI-familiar way (bigger =
// stronger), intra-cloud strikes smaller and lighter than cloud-to-ground.
// Client rendering draws at full devicePixelRatio — crisper than the old
// PNG8 raster ever was.
//
const CG_COLOR = '#FFD100';
const IC_COLOR = 'rgba(255, 224, 130, 0.85)';
const HALO_COLOR = '#232323';

function cross(radius, width, color) {
  return new Style({
    image: new RegularShape({
      points: 4,
      radius,
      radius2: 0,
      angle: Math.PI / 4,
      stroke: new Stroke({ color, width, lineCap: 'round' }),
    }),
  });
}

// |peak_current| buckets (kA). NaN (value missing) lands in the middle one.
const BUCKETS = [
  { min: 30, radius: 8, width: 3 },
  { min: 10, radius: 6.5, width: 2.5 },
  { min: 0, radius: 5, width: 2 },
];

// Style pairs (halo under, color over) are static and shared across
// features — cached per (bucket, cloud) combination.
const styleCache = new Map();
function strikeStyle(peakCurrent, cloud) {
  const absKa = Number.isFinite(peakCurrent) ? Math.abs(peakCurrent) : 15;
  const bucket = BUCKETS.find((b) => absKa >= b.min) || BUCKETS[BUCKETS.length - 1];
  const key = `${bucket.min}|${cloud ? 1 : 0}`;
  if (!styleCache.has(key)) {
    const radius = cloud ? bucket.radius * 0.7 : bucket.radius;
    const width = cloud ? bucket.width * 0.8 : bucket.width;
    styleCache.set(key, [
      cross(radius, width + 2.5, HALO_COLOR),
      cross(radius, width, cloud ? IC_COLOR : CG_COLOR),
    ]);
  }
  return styleCache.get(key);
}

export default function initLightningLayer({ defaultProduct, onWmsProduct }) {
  const client = createLightningClient();
  const entries = []; // one per pane, in pane-index order
  let frameTimesMs = null;
  let stepMs = 5 * 60000;
  let frameIndex = FRAME_COUNT - 1;
  // Current frame's strike slice; the style function reads these.
  let sliceFromMs = 0;
  let sliceToMs = Infinity;
  let windowKey = '';
  let builtRevision = -1;
  let builtKey = '';
  let moveTimer = null;

  function currentViewExtent() {
    for (const entry of entries) {
      const size = entry.map && entry.map.getSize();
      if (size && size[0] > 0 && size[1] > 0) {
        const extent = entry.map.getView().calculateExtent(size);
        const [w, s] = toLonLat([extent[0], extent[1]]);
        const [e, n] = toLonLat([extent[2], extent[3]]);
        return [w, s, e, n];
      }
    }
    return null;
  }

  function updateSlice() {
    if (!frameTimesMs) return;
    const frameT = frameTimesMs[frameIndex];
    sliceFromMs = frameT - stepMs;
    // Newest frame: open-ended so live-polled strikes show without waiting
    // for the (radar-lagged) window end to advance past them.
    sliceToMs = frameIndex === FRAME_COUNT - 1 ? Infinity : frameT;
  }

  function anyEdrVisible() {
    return entries.some((e) => e.mode === 'edr' && e.layer.getVisible());
  }

  // Companion mirrors the category visibility only while a WMS product is
  // selected; the vector face renders only in EDR mode.
  function syncEntry(entry) {
    if (entry.companion) {
      entry.companion.setVisible(entry.layer.getVisible() && entry.mode === 'wms');
    }
  }

  function rebuild() {
    if (!frameTimesMs) return;
    const strikes = client.all();
    for (const entry of entries) {
      if (entry.mode === 'edr' && entry.layer.getVisible()) {
        const features = strikes.map((strike) => {
          const feature = new Feature(new Point(fromLonLat([strike.lon, strike.lat])));
          feature.set('t', strike.t, true);
          feature.set('kA', strike.peakCurrent, true);
          feature.set('ic', strike.cloud, true);
          return feature;
        });
        entry.source.clear(true);
        entry.source.addFeatures(features);
      } else {
        entry.source.clear(true);
      }
    }
  }

  function rebuildIfChanged() {
    const key = `${windowKey}|${entries.map((e) => `${e.mode}:${e.layer.getVisible() ? 1 : 0}`).join(',')}`;
    if (client.revision() !== builtRevision || key !== builtKey) {
      builtRevision = client.revision();
      builtKey = key;
      rebuild();
    }
  }

  async function refetch() {
    if (frameTimesMs && anyEdrVisible()) {
      const viewExtent = currentViewExtent();
      if (viewExtent) {
        try {
          await client.ensureRange({
            viewExtent,
            // Frame 0's slice reaches one step behind the window start.
            startMs: frameTimesMs[0] - stepMs,
            endMs: frameTimesMs[FRAME_COUNT - 1],
          });
        } catch (err) {
          if (!err || err.name !== 'AbortError') {
            console.warn('EDR lightning fetch failed:', err); // eslint-disable-line no-console
          }
        }
      }
    }
    rebuildIfChanged();
  }

  function scheduleRefetch() {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refetch, MOVE_DEBOUNCE_MS);
  }

  // The 45 s live top-up (v1 feature): newest strikes are seconds behind
  // wall clock, the newest frame's open slice shows them as they land.
  setInterval(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!anyEdrVisible()) return;
    try {
      const added = await client.pollLatest(Date.now());
      if (added > 0) rebuildIfChanged();
    } catch (err) {
      if (!err || err.name !== 'AbortError') {
        console.warn('EDR lightning live poll failed:', err); // eslint-disable-line no-console
      }
    }
  }, LIVE_POLL_MS);

  return {
    // Layer factory handed to createPane — runs before the pane's Map and
    // companion exist; bindPane() completes the pairing.
    createPaneLayer(paneIndex, visible) {
      const source = new VectorSource();
      const entry = {
        index: paneIndex,
        product: defaultProduct,
        mode: EDR_PRODUCTS.has(defaultProduct) ? 'edr' : 'wms',
        source,
        layer: null,
        companion: null,
        map: null,
      };
      // WMS-facade — see module header. Covers BOTH modes: with a WMS
      // product selected the facade reports li_afa/rdt, so menu selection
      // state and persistence stay correct.
      source.getParams = () => ({ LAYERS: entry.product });
      source.updateParams = (params) => {
        const id = params && params.LAYERS;
        if (!id || id === entry.product) return;
        entry.product = id;
        entry.mode = EDR_PRODUCTS.has(id) ? 'edr' : 'wms';
        syncEntry(entry);
        if (entry.mode === 'wms') {
          if (onWmsProduct && entry.companion) onWmsProduct(entry.companion, id);
        } else {
          refetch();
        }
        rebuildIfChanged();
      };
      const layer = new VectorLayer({
        name: 'lightningLayer',
        visible,
        source,
        style: (feature) => {
          const t = feature.get('t');
          if (!(t > sliceFromMs && t <= sliceToMs)) return undefined;
          return strikeStyle(feature.get('kA'), feature.get('ic'));
        },
      });
      layer.setLayerUrl = () => {};
      layer.on('change:visible', () => {
        syncEntry(entry);
        if (layer.getVisible()) refetch(); else rebuildIfChanged();
      });
      entry.layer = layer;
      entries.push(entry);
      return layer;
    },

    // Called once the pane's Map and companion WMS layer exist.
    bindMap(paneIndex, map, companion) {
      const entry = entries.find((e) => e.index === paneIndex);
      if (!entry || entry.map) return;
      entry.map = map;
      entry.companion = companion || null;
      syncEntry(entry);
      map.on('moveend', scheduleRefetch);
      // The clock's first route() can run before the map has a size; retry
      // once the pane has rendered.
      map.once('postrender', scheduleRefetch);
    },

    // setTime gates the companion's FramePool routing on this.
    isWmsMode(paneIndex) {
      const entry = entries.find((e) => e.index === paneIndex);
      return !!entry && entry.mode === 'wms';
    },

    // Clock fan-out — window change → (deduped) fetch + rebuild; cursor
    // move → new slice + restyle only.
    route(windowStartMs, windowStepMs, cursorMs) {
      const key = `${windowStartMs}|${windowStepMs}`;
      stepMs = windowStepMs;
      let changed = false;
      if (key !== windowKey) {
        windowKey = key;
        frameTimesMs = Array.from({ length: FRAME_COUNT }, (_, i) => windowStartMs + i * windowStepMs);
        changed = true;
        refetch();
      }
      const idx = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round((cursorMs - windowStartMs) / windowStepMs)));
      if (idx !== frameIndex) {
        frameIndex = idx;
        changed = true;
      }
      if (changed) {
        updateSlice();
        for (const entry of entries) {
          if (entry.mode === 'edr' && entry.layer.getVisible()) entry.layer.changed();
        }
      }
    },
  };
}
