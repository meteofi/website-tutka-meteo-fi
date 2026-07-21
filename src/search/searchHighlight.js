// Cross-pane highlight pulse for the place-search feature: a dot plus an
// expanding, fading ring shown for ~2.5 s at the searched location. Same
// cross-pane pattern as rangeCircle/placeNames — ONE shared VectorSource,
// one VectorLayer per pane (created via the paneDeps factory), so the pulse
// appears in every active pane of a split screen.
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import {
  Circle as CircleStyle, Fill, Stroke, Style,
} from 'ol/style';

const PULSE_MS = 2500;
const DOT_RADIUS = 5;
const RING_START = 8;
const RING_GROWTH = 40;

export default function initSearchHighlight() {
  const source = new VectorSource();
  let startTs = 0;
  let rafId = 0;

  // Fraction of the pulse elapsed, clamped to [0, 1].
  const progress = () => Math.min((performance.now() - startTs) / PULSE_MS, 1);

  const styleFn = () => {
    const t = progress();
    const ease = 1 - (1 - t) ** 3;
    return [
      new Style({
        image: new CircleStyle({
          radius: RING_START + RING_GROWTH * ease,
          stroke: new Stroke({
            color: `rgba(18, 188, 250, ${0.9 * (1 - t)})`,
            width: 3 - 1.5 * t,
          }),
        }),
      }),
      new Style({
        image: new CircleStyle({
          radius: DOT_RADIUS,
          fill: new Fill({ color: '#12BCFA' }),
          stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 2 }),
        }),
      }),
    ];
  };

  const clear = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    source.clear();
  };

  const tick = () => {
    if (progress() >= 1) {
      clear();
      return;
    }
    // Repaint every layer sharing the source (all panes) with the new radius.
    source.changed();
    rafId = requestAnimationFrame(tick);
  };

  return {
    // Factory for paneDeps: every pane (including ones created later by a
    // split-screen layout switch) hosts its own layer over the shared source.
    createPaneLayer() {
      return new VectorLayer({
        source,
        // The ring must keep rendering during the fly-to view animation and
        // any user pan that interrupts it.
        updateWhileAnimating: true,
        updateWhileInteracting: true,
        // Deliberately no `declutter`: joining a declutter group would let
        // the ring erase other layers' labels (see placeNames.js notes).
        style: styleFn,
      });
    },
    // coord is in view projection (EPSG:3857).
    pulseAt(coord) {
      clear();
      source.addFeature(new Feature(new Point(coord)));
      startTs = performance.now();
      rafId = requestAnimationFrame(tick);
    },
    clear,
  };
}
