import { RadarInterpolator } from './index';

// Owns interpolator attachment across pools; mode persistence and pane-0 state
// remain with the app. Read callbacks reflect the current playback and layout.
export default function createInterpolationController({
  getMode, getPanes, getActivePanes, isPlaying, debug,
}) {
  const visibilityListeners = new Map();

  function attachPool(pane, name, pool) {
    if (getMode() === 'off' || !pool.primary.getVisible() || pool.interpolator) return;
    // A hidden product needs neither a context nor compiled shaders. Read mode
    // and playback now: either may have changed since the pool was registered.
    let interpolator = null;
    try {
      interpolator = new RadarInterpolator({
        useFlow: getMode() === 'flow', motionProfile: name === 'satelliteLayer' ? 'satellite' : 'radar',
      });
    } catch (err) {
      // Leave ordinary frames available if GPU setup fails. A later explicit
      // visibility/layout change may retry; never spin on an unavailable GPU.
      debug(`RadarInterpolator unavailable (pane ${pane.index} ${name}): ${err.message}`);
    }
    if (interpolator) {
      pool.setInterpolator(interpolator);
      pool.refreshFlows();
      pool.setInterpActive(isPlaying());
    }
  }

  function attachInterpolators() {
    if (getMode() === 'off') return;
    for (const pane of getActivePanes()) {
      for (const name of ['radarLayer', 'satelliteLayer']) {
        const pool = pane.framePools[name];
        if (pool) {
          if (!visibilityListeners.has(pool)) {
            const onVisible = () => attachPool(pane, name, pool);
            visibilityListeners.set(pool, onVisible);
            pool.primary.on('change:visible', onVisible);
          }
          attachPool(pane, name, pool);
        }
      }
    }
  }

  // Tear down one pane's interpolators, releasing their GL resources. Used both
  // when interp is switched off and when a pane drops out of the active set.
  function detachPaneInterpolators(pane) {
    for (const name of ['radarLayer', 'satelliteLayer']) {
      const pool = pane.framePools[name];
      if (pool && visibilityListeners.has(pool)) {
        pool.primary.un('change:visible', visibilityListeners.get(pool));
        visibilityListeners.delete(pool);
      }
      if (pool && pool.interpolator) {
        pool.setInterpActive(false);
        pool.setInterpolator(null);
      }
    }
  }

  function detachInterpolators() {
    // Detach from ALL panes (including inactive ones) so toggling interp off
    // fully releases GPU resources regardless of the current layout.
    for (const pane of getPanes()) detachPaneInterpolators(pane);
  }

  function setUseFlow(useFlow) {
    for (const pane of getActivePanes()) {
      for (const name of ['radarLayer', 'satelliteLayer']) {
        const pool = pane.framePools[name];
        if (pool && pool.interpolator) {
          pool.interpolator.setUseFlow(useFlow);
          pool.refreshFlows();
        }
      }
    }
  }

  return {
    attachInterpolators, detachPaneInterpolators, detachInterpolators, setUseFlow,
  };
}
