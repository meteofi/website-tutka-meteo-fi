// Client-rendered observation layer (EDR-backed) — replaces the WMS obs
// raster when localStorage.OBS_EDR === '1' (PR 2 of the obs WMS→EDR
// migration; WMS stays the default until the flag flips).
//
// One controller serves every pane: a single EDR client (src/obs/
// edrObservations.js) holds the station data, and each pane gets its own
// VectorLayer + VectorSource built from the same snapped rows (features
// can't be shared across sources; the value arrays are). Panes can show
// different products (pill long-press menu) — the client fetches the union
// of the visible panes' parameters in one request set.
//
// The layer impersonates the WMS obs layer everywhere radar.js touches it,
// so the wiring diff stays minimal:
//   - source.getParams()        → { LAYERS: <this pane's product id> }
//   - source.updateParams({LAYERS}) → product switch (other keys ignored:
//     FORMAT/TRANSPARENT/ELEVATION/STYLES have no vector meaning)
//   - layer.setLayerUrl()       → no-op (updateLayer calls it with the WMS
//     url from GetCapabilities, which still advertises these products)
// Everything else — visibility toggles, opacity, ACTIVE_LAYERS persistence,
// canonical page, playlist, share attributions — reads through those two
// facades untouched.
//
// Clock contract: radar.js setTime calls route(windowStartMs, stepMs,
// cursorMs) once per tick instead of FramePool setWindow/showTime. A window
// change triggers an (idempotent, deduped) fetch; a cursor change just flips
// the frame index and re-renders — no network, that's the point of holding
// the whole window client-side.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { fromLonLat, toLonLat } from 'ol/proj';
import { createObsClient, OBS_PRODUCTS } from './edrObservations';
import createObsStyle from './obsStyles';

// Pan/zoom settle time before re-checking the fetched polygon. The quantized
// bounds make most moveends a no-op; this only spaces out the checks.
const MOVE_DEBOUNCE_MS = 300;
// The very first fetch waits longer: at boot the 13 radar frames must win
// the bandwidth and the main thread, and the first seconds shift the window
// several times (each GetCapabilities arrival) — one deferred fetch replaces
// that burst. Labels appear ~2 s later; radar appears sooner.
const FIRST_FETCH_DELAY_MS = 2000;
const FRAME_COUNT = 13;

export default function initObsLayer({ defaultProduct }) {
  // Low-priority hint (Chromium; ignored elsewhere): observation data must
  // not outrank the radar frame images the user is actually waiting for.
  const client = createObsClient({
    fetchImpl: (url, opts) => fetch(url, { ...opts, priority: 'low' }),
  });
  const entries = []; // one per pane, in pane-index order
  let frameTimesMs = null;
  let frameIndex = FRAME_COUNT - 1;
  let windowKey = '';
  let builtRevision = -1;
  let builtKey = '';
  let moveTimer = null;
  let fetchAttempted = false;

  // The first pane with a laid-out map defines the shared viewport (all
  // panes share one View; inactive panes have size 0 and are skipped).
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

  function visibleProducts() {
    const products = new Set();
    for (const entry of entries) {
      if (entry.layer.getVisible() && OBS_PRODUCTS[entry.product]) products.add(entry.product);
    }
    return [...products];
  }

  // Rebuild every visible pane's features from the client's current store.
  // Cheap (hundreds of small features) and only runs when the data revision
  // or the window actually changed.
  function rebuild() {
    if (!frameTimesMs) return;
    for (const entry of entries) {
      if (entry.layer.getVisible()) {
        const rows = client.snapToFrames(frameTimesMs, entry.product);
        const features = rows.map((row) => {
          const feature = new Feature(new Point(fromLonLat([row.lon, row.lat])));
          feature.set('obs', row.values, true);
          return feature;
        });
        entry.source.clear(true);
        entry.source.addFeatures(features);
      }
    }
  }

  function rebuildIfChanged() {
    const key = `${windowKey}|${entries.map((e) => `${e.product}:${e.layer.getVisible() ? 1 : 0}`).join(',')}`;
    if (client.revision() !== builtRevision || key !== builtKey) {
      builtRevision = client.revision();
      builtKey = key;
      rebuild();
    }
  }

  function scheduleRefetch() {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refetch, fetchAttempted ? MOVE_DEBOUNCE_MS : FIRST_FETCH_DELAY_MS);
  }

  async function refetch() {
    fetchAttempted = true;
    if (!frameTimesMs) return;
    const products = visibleProducts();
    const viewExtent = currentViewExtent();
    if (products.length && viewExtent) {
      try {
        await client.ensureWindow({
          viewExtent,
          products,
          startMs: frameTimesMs[0],
          endMs: frameTimesMs[FRAME_COUNT - 1],
        });
      } catch (err) {
        // Keep whatever data we have; the next tick / moveend retries.
        if (!err || err.name !== 'AbortError') {
          console.warn('EDR observations fetch failed:', err); // eslint-disable-line no-console
        }
      }
    }
    rebuildIfChanged();
  }

  return {
    // Layer factory handed to createPane (deps.createObservationLayer) — runs
    // during pane construction, before the pane's Map exists; bindMap() below
    // completes the pairing.
    createPaneLayer(paneIndex, visible) {
      const source = new VectorSource();
      const entry = {
        index: paneIndex, product: defaultProduct, source, layer: null, map: null,
      };
      // WMS-facade: see module header.
      source.getParams = () => ({ LAYERS: entry.product });
      source.updateParams = (params) => {
        const id = params && params.LAYERS;
        if (id && id !== entry.product && OBS_PRODUCTS[id]) {
          entry.product = id;
          // Render what the store already has for the new product right
          // away; the fetch tops up if its parameters weren't covered yet.
          rebuildIfChanged();
          scheduleRefetch();
        }
      };
      const layer = new VectorLayer({
        name: 'observationLayer',
        visible,
        declutter: true,
        source,
        style: createObsStyle({
          getProduct: () => entry.product,
          getFrameIndex: () => frameIndex,
        }),
      });
      layer.setLayerUrl = () => {};
      layer.on('change:visible', () => {
        if (layer.getVisible()) scheduleRefetch(); else rebuildIfChanged();
      });
      entry.layer = layer;
      entries.push(entry);
      return layer;
    },

    // Called once the pane's Map exists. The moveend listener re-checks the
    // fetched polygon after pans/zooms; the quantized-bounds no-op in the
    // client makes casual pans free.
    bindMap(paneIndex, map) {
      const entry = entries.find((e) => e.index === paneIndex);
      if (!entry || entry.map) return;
      entry.map = map;
      map.on('moveend', scheduleRefetch);
      // The clock's first route() can run before the map has a size (boot
      // order), which skips the fetch; retry once the pane has rendered.
      map.once('postrender', scheduleRefetch);
    },

    // Clock fan-out — the FramePool setWindow/showTime equivalent, called
    // from setTime every tick. Window change → fetch + rebuild; cursor
    // change → restyle only.
    route(windowStartMs, stepMs, cursorMs) {
      const key = `${windowStartMs}|${stepMs}`;
      if (key !== windowKey) {
        windowKey = key;
        frameTimesMs = Array.from({ length: FRAME_COUNT }, (_, i) => windowStartMs + i * stepMs);
        scheduleRefetch();
      }
      const idx = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round((cursorMs - windowStartMs) / stepMs)));
      if (idx !== frameIndex) {
        frameIndex = idx;
        for (const entry of entries) {
          if (entry.layer.getVisible()) entry.layer.changed();
        }
      }
    },
  };
}
