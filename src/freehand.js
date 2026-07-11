import Draw from 'ol/interaction/Draw';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import { Stroke, Style } from 'ol/style';
import { unByKey } from 'ol/Observable';

const STROKE_STYLE = new Style({
  stroke: new Stroke({
    color: '#E255C7',
    width: 3,
    lineCap: 'round',
    lineJoin: 'round',
  }),
});

// Piirto: drag to draw freehand strokes on the map; strokes accumulate until
// the tool is disarmed. Same cross-pane design as rangeCircle: one shared
// VectorSource rendered through a per-pane VectorLayer, and a per-pane Draw
// interaction with an invisible sketch — panes share one View, so a stroke
// drawn in any pane mirrors pixel-identically in all of them.
export default function initFreehand() {
  const source = new VectorSource();
  const attached = [];
  let armed = false;
  let liveFeature = null;
  let changeKey = null;

  function clear() {
    source.clear();
    liveFeature = null;
  }

  function detachSketch() {
    if (changeKey) {
      unByKey(changeKey);
      changeKey = null;
    }
  }

  function attachPane(paneMap) {
    const layer = new VectorLayer({
      source,
      style: STROKE_STYLE,
      updateWhileAnimating: true,
      updateWhileInteracting: true,
    });
    paneMap.addLayer(layer);
    const draw = new Draw({
      type: 'LineString',
      freehand: true,
      stopClick: true,
      style: [],
    });
    // Mirror the (invisible) sketch into a shared-source feature so the
    // stroke renders live in every pane, not just the one being drawn in.
    draw.on('drawstart', (e) => {
      const sketchGeom = e.feature.getGeometry();
      liveFeature = new Feature(new LineString(sketchGeom.getCoordinates()));
      source.addFeature(liveFeature);
      changeKey = sketchGeom.on('change', () => {
        liveFeature.getGeometry().setCoordinates(sketchGeom.getCoordinates());
      });
    });
    // The finished stroke stays in the shared source — strokes accumulate.
    draw.on('drawend', () => {
      detachSketch();
      liveFeature = null;
    });
    // Tap-abort / Esc / setActive(false): drop the unfinished stroke only.
    draw.on('drawabort', () => {
      detachSketch();
      if (liveFeature) source.removeFeature(liveFeature);
      liveFeature = null;
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
      // setActive(false) mid-stroke auto-aborts → drawabort drops the sketch.
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
