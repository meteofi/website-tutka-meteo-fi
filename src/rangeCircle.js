import Draw from 'ol/interaction/Draw';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import Polygon, { circular } from 'ol/geom/Polygon';
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';
import { transform } from 'ol/proj';
import { getDistance } from 'ol/sphere';
import LatLon from 'geodesy/latlon-spherical';
import {
  formatDistance, lineLabelStyle, COMPASS_16_EN, compassIndex,
} from './tools';

const CIRCLE_STYLE = new Style({
  stroke: new Stroke({ color: 'rgba(18, 188, 250, 0.85)', width: 2 }),
  fill: new Fill({ color: 'rgba(18, 188, 250, 0.08)' }),
});

function centerLabelStyle(text) {
  return new Style({
    image: new CircleStyle({
      radius: 3,
      fill: new Fill({ color: '#12BCFA' }),
      stroke: new Stroke({ color: '#ffffff', width: 1 }),
    }),
    text: new Text({
      text,
      font: 'bold 16px Roboto, sans-serif',
      offsetY: -24,
      textAlign: 'center',
      fill: new Fill({ color: '#ffffff' }),
      // Outline so the label stays legible over any radar/map colour
      stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.85)', width: 4 }),
    }),
  });
}

// Etäisyysrengas: press-and-drag draws a geodesic circle around the press
// point, with the radius labelled at the centre and a spoke line to the drag
// point labelled with the bearing. One shared VectorSource is rendered through
// a per-pane VectorLayer, and every pane gets its own Draw interaction with an
// invisible sketch — panes share one View, so a drag started in any pane
// mirrors pixel-identically in all of them.
//
// onStrokeEnd fires whenever a drag gesture ends (drawend or drawabort). The
// caller needs it to unstick its clock gating: a draw stroke consumes the
// whole pointer sequence without moving the view, so the moveend that
// normally follows a drag never fires.
export default function initRangeCircle({ onStrokeEnd } = {}) {
  const emitStrokeEnd = typeof onStrokeEnd === 'function' ? onStrokeEnd : () => {};
  const source = new VectorSource();
  const attached = [];
  let armed = false;
  // True from drawstart until the drag's first real movement: the previous
  // circle is replaced lazily, so a stray tap (which self-aborts) keeps it.
  let pendingClear = false;
  let liveRadius = 0;
  let circleFeature = null;
  let spokeFeature = null;
  let centerFeature = null;

  function clear() {
    source.clear();
    circleFeature = null;
    spokeFeature = null;
    centerFeature = null;
  }

  function ensureLiveFeatures() {
    if (circleFeature) return;
    circleFeature = new Feature(new Polygon([]));
    circleFeature.setStyle(CIRCLE_STYLE);
    spokeFeature = new Feature(new LineString([]));
    centerFeature = new Feature(new Point([0, 0]));
    source.addFeatures([circleFeature, spokeFeature, centerFeature]);
  }

  // Called by Draw on every drag event with [center, current] in the view
  // projection. The sketch geometry it returns is never rendered (style: []) —
  // the visible graphics are the shared-source features updated as a side
  // effect, which is what makes them appear in every pane.
  function geometryFunction(coordinates, geometry, projection) {
    const [center, tip] = coordinates;
    const c = transform(center, projection, 'EPSG:4326');
    const t = transform(tip, projection, 'EPSG:4326');
    const radius = getDistance(c, t);
    liveRadius = radius;
    const ring = circular(c, Math.max(radius, 1), 128).transform('EPSG:4326', projection);
    if (radius >= 1) {
      if (pendingClear) {
        clear();
        pendingClear = false;
      }
      ensureLiveFeatures();
      circleFeature.getGeometry().setCoordinates(ring.getCoordinates());
      spokeFeature.getGeometry().setCoordinates([center.slice(), tip.slice()]);
      centerFeature.getGeometry().setCoordinates(center.slice());
      const brg = new LatLon(c[1], c[0]).initialBearingTo(new LatLon(t[1], t[0]));
      centerFeature.setStyle(centerLabelStyle(formatDistance(radius)));
      spokeFeature.setStyle(lineLabelStyle(`${brg.toFixed(0)}° ${COMPASS_16_EN[compassIndex(brg)]}`));
    }
    // Keep the (invisible) sketch a valid ring even at radius ~0 — Draw's
    // Circle mode expects a non-empty polygon back.
    const geom = geometry || new Polygon([]);
    geom.setCoordinates(ring.getCoordinates());
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
      type: 'Circle',
      freehand: true,
      stopClick: true,
      style: [],
      geometryFunction,
    });
    draw.on('drawstart', () => {
      pendingClear = true;
      liveRadius = 0;
    });
    // Released back at (within a metre of) the start point: nothing to show.
    draw.on('drawend', () => {
      if (liveRadius < 1) clear();
      emitStrokeEnd();
    });
    // Mid-stroke abort (Esc / setActive(false)) clears the partial circle; a
    // tap-abort (pendingClear still true) keeps the previous one.
    draw.on('drawabort', () => {
      if (!pendingClear) clear();
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
    if (!armed) clear();
  }

  return {
    attachPane,
    arm: () => setArmed(true),
    disarm: () => setArmed(false),
    clear,
  };
}
