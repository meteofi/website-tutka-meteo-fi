import Draw from 'ol/interaction/Draw';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';
import { transform } from 'ol/proj';
import { getDistance } from 'ol/sphere';
import { formatDistance, lineLabelStyle } from './tools';

// A drawn line shorter than this is meaningless as a cross-section (the
// server samples every ~500 m); releasing below it clears the line instead
// of querying.
const MIN_LINE_M = 1000;

// Endpoint markers match the measure tool's T1/T2 pair so the A/B letters on
// the cross-section chart read as "same colors as on the map".
function endpointStyle(letter, color) {
  return new Style({
    image: new CircleStyle({
      radius: 7,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
    text: new Text({
      text: letter,
      font: 'bold 12px Roboto, sans-serif',
      offsetY: -20,
      textAlign: 'center',
      fill: new Fill({ color: '#ffffff' }),
      // Outline so the label stays legible over any radar/map colour
      stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.85)', width: 4 }),
    }),
  });
}

const A_STYLE = endpointStyle('A', '#12BCFA');
const B_STYLE = endpointStyle('B', '#E255C7');

// Poikkileikkaus line: press-and-drag draws a straight A→B rubber-band line;
// releasing emits the endpoints so the controller can query the EDR
// trajectory endpoint. One shared VectorSource is rendered through a
// per-pane VectorLayer, and every pane gets its own Draw interaction with an
// invisible sketch — panes share one View, so a drag started in any pane
// mirrors pixel-identically in all of them (same design as rangeCircle).
//
// onLineChange fires with [[lonA, latA], [lonB, latB]] (EPSG:4326) when a
// valid line is completed, and with null whenever the line goes away
// (too-short replacement, mid-stroke abort, disarm) so the caller can close
// its panel and abort fetches.
//
// onStrokeEnd fires whenever a drag gesture ends (drawend or drawabort). The
// caller needs it to unstick its clock gating: a draw stroke consumes the
// whole pointer sequence without moving the view, so the moveend that
// normally follows a drag never fires.
export default function initSectionLine({ onLineChange, onStrokeEnd } = {}) {
  const emitStrokeEnd = typeof onStrokeEnd === 'function' ? onStrokeEnd : () => {};
  const emitLineChange = typeof onLineChange === 'function'
    ? (line) => { try { onLineChange(line); } catch (_) { /* ignore */ } }
    : () => {};
  const source = new VectorSource();
  const attached = [];
  let armed = false;
  // True from drawstart until the drag's first real movement: the previous
  // line is replaced lazily, so a stray tap (which self-aborts) keeps it.
  let pendingClear = false;
  let liveLength = 0;
  let liveLine4326 = null; // [[lonA, latA], [lonB, latB]] of the current drag
  let committedLine = null; // last emitted line, or null
  let lineFeature = null;
  let aFeature = null;
  let bFeature = null;

  function clear() {
    source.clear();
    lineFeature = null;
    aFeature = null;
    bFeature = null;
  }

  // Clear + tell the caller the line is gone, but only when it had one —
  // disarm after a tap-only session shouldn't churn the controller.
  function clearAndNotify() {
    clear();
    if (committedLine) {
      committedLine = null;
      emitLineChange(null);
    }
  }

  function ensureLiveFeatures() {
    if (lineFeature) return;
    lineFeature = new Feature(new LineString([]));
    aFeature = new Feature(new Point([0, 0]));
    aFeature.setStyle(A_STYLE);
    bFeature = new Feature(new Point([0, 0]));
    bFeature.setStyle(B_STYLE);
    source.addFeatures([lineFeature, aFeature, bFeature]);
  }

  // Called by Draw on every drag event with the accumulated freehand vertices
  // in the view projection; only the first and latest matter — the visible
  // graphics are a straight segment between them. The sketch geometry it
  // returns is never rendered (style: []) — the shared-source features
  // updated as a side effect are what appear in every pane.
  function geometryFunction(coordinates, geometry, projection) {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const a = transform(first, projection, 'EPSG:4326');
    const b = transform(last, projection, 'EPSG:4326');
    liveLength = getDistance(a, b);
    liveLine4326 = [a, b];
    if (liveLength >= 1) {
      if (pendingClear) {
        clear();
        pendingClear = false;
      }
      ensureLiveFeatures();
      lineFeature.getGeometry().setCoordinates([first.slice(), last.slice()]);
      aFeature.getGeometry().setCoordinates(first.slice());
      bFeature.getGeometry().setCoordinates(last.slice());
      lineFeature.setStyle(lineLabelStyle(formatDistance(liveLength)));
    }
    const geom = geometry || new LineString([]);
    geom.setCoordinates([first.slice(), last.slice()]);
    return geom;
  }

  function attachPane(paneMap) {
    const layer = new VectorLayer({
      source,
      updateWhileAnimating: true,
      updateWhileInteracting: true,
    });
    paneMap.addLayer(layer);
    const draw = new Draw({
      type: 'LineString',
      freehand: true,
      stopClick: true,
      style: [],
      geometryFunction,
    });
    draw.on('drawstart', () => {
      pendingClear = true;
      liveLength = 0;
      liveLine4326 = null;
    });
    draw.on('drawend', () => {
      if (liveLength >= MIN_LINE_M) {
        committedLine = liveLine4326;
        emitLineChange(committedLine);
      } else {
        // Moved, but not far enough for a meaningful section: the previous
        // line was already replaced by the short live one, so drop both.
        clearAndNotify();
      }
      emitStrokeEnd();
    });
    // Mid-stroke abort (Esc / setActive(false)) clears the partial line; a
    // tap-abort (pendingClear still true) keeps the previous one.
    draw.on('drawabort', () => {
      if (!pendingClear) clearAndNotify();
      pendingClear = false;
      emitStrokeEnd();
    });
    // Panes can be created while the tool is armed (1-up → 4-up switch).
    draw.setActive(armed);
    paneMap.addInteraction(draw);
    const el = paneMap.getTargetElement();
    attached.push({ draw, el });
    if (armed && el) el.classList.add('tool-armed');
  }

  function setArmed(next) {
    armed = next;
    for (const { draw, el } of attached) {
      // setActive(false) mid-stroke auto-aborts → drawabort clears the sketch.
      draw.setActive(armed);
      if (el) el.classList.toggle('tool-armed', armed);
    }
    if (!armed) clearAndNotify();
  }

  return {
    attachPane,
    arm: () => setArmed(true),
    disarm: () => setArmed(false),
    clear: clearAndNotify,
    getLine: () => committedLine,
  };
}
