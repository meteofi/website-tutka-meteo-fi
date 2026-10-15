import { RadarInterpolator } from './index';

// Owns interpolator attachment across pools; mode persistence and pane-0 state
// remain with the app. Read callbacks reflect the current playback and layout.
export default function createInterpolationController({
  getMode, getPanes, getActivePanes, isPlaying, debug,
}) {
  function attachInterpolators() {
    if (getMode() === 'off') return;
    const playing = isPlaying();
    const useFlow = getMode() === 'flow';
    for (const pane of getActivePanes()) {
      for (const name of ['radarLayer', 'satelliteLayer']) {
        const pool = pane.framePools[name];
        if (pool && !pool.interpolator) {
          // WebGL2 context creation can fail even though the boot probe
          // passed: browsers cap live contexts (~8-16) and 4-up with radar +
          // satellite wants up to 8. Leave this pool on discrete frames
          // instead of letting the throw abort the caller mid-layout with a
          // half-initialized split.
          let interpolator = null;
          try {
            interpolator = new RadarInterpolator({ useFlow, motionProfile: name === 'satelliteLayer' ? 'satellite' : 'radar' });
          } catch (err) {
            debug(`RadarInterpolator unavailable (pane ${pane.index} ${name}): ${err.message}`);
          }
          if (interpolator) {
            pool.setInterpolator(interpolator);
            pool.refreshFlows();
            if (playing) pool.setInterpActive(true);
          }
        }
      }
    }
  }

  // Tear down one pane's interpolators, releasing their GL resources. Used both
  // when interp is switched off and when a pane drops out of the active set.
  function detachPaneInterpolators(pane) {
    for (const name of ['radarLayer', 'satelliteLayer']) {
      const pool = pane.framePools[name];
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
