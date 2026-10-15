/* eslint-disable import/extensions, no-console */
// Real OL visibility events and the production owner; GPU setup and FramePool's
// separately tested rendering/loading lifecycle are replaced at their boundary.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import ImageLayer from 'ol/layer/Image.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/poolController.js') && specifier === './index') {
      return { url: 'test:interpolator', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== 'test:interpolator') return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `export class RadarInterpolator {
        static created = []; static failures = 0;
        constructor(options) {
          if (RadarInterpolator.failures) {
            RadarInterpolator.failures--; throw new Error('GPU unavailable');
          }
          Object.assign(this, options); RadarInterpolator.created.push(this);
        }
        setUseFlow(value) { this.useFlow = value; }
        dispose() { this.disposed = true; }
      }`,
    };
  },
});
const { default: createController } = await import('../src/animation/interpolation/poolController.js');
// eslint-disable-next-line import/no-unresolved
const { RadarInterpolator } = await import('test:interpolator');
hooks.deregister();

function pool(visible) {
  return {
    primary: new ImageLayer({ visible }),
    interpolator: null,
    interpActive: false,
    refreshes: 0,
    setInterpolator(value) {
      if (this.interpolator) this.interpolator.dispose();
      this.interpolator = value;
    },
    setInterpActive(value) { this.interpActive = value; },
    refreshFlows() { this.refreshes++; },
  };
}

function harness() {
  const state = { mode: 'flow', playing: true, count: 1 };
  const panes = Array.from({ length: 4 }, (_, index) => ({
    index, framePools: { radarLayer: pool(true), satelliteLayer: pool(false), lightningWmsLayer: pool(true) },
  }));
  const errors = [];
  const controller = createController({
    getMode: () => state.mode,
    getPanes: () => panes,
    getActivePanes: () => panes.slice(0, state.count),
    isPlaying: () => state.playing,
    debug: (message) => errors.push(message),
  });
  const mode = (value) => {
    const previous = state.mode; state.mode = value;
    if (value === 'off') controller.detachInterpolators();
    else if (previous === 'off') controller.attachInterpolators();
    else controller.setUseFlow(value === 'flow');
  };
  return {
    state, panes, errors, controller, mode,
  };
}

{
  const h = harness(); const { controller, panes } = h;
  controller.attachInterpolators(); controller.attachInterpolators();
  const { radarLayer: radar, satelliteLayer: satellite, lightningWmsLayer: lightning } = panes[0].framePools;
  assert.equal(radar.interpolator.motionProfile, 'radar');
  assert.equal(radar.interpActive, true);
  assert.equal(radar.refreshes, 1, 'repeated attachment does not queue duplicate work');
  assert.equal(satellite.interpolator, null, 'hidden satellite has no renderer');
  assert.equal(lightning.interpolator, null, 'only radar and satellite interpolate');
  h.state.playing = false; h.mode('crossfade');
  satellite.primary.setVisible(true);
  const engine = satellite.interpolator;
  assert.equal(engine.motionProfile, 'satellite');
  assert.equal(engine.useFlow, false, 'first show uses the latest mode');
  assert.equal(satellite.interpActive, false, 'first show respects a later pause');
  satellite.primary.setVisible(false); h.mode('flow');
  satellite.primary.setVisible(true);
  assert.equal(satellite.interpolator, engine, 'warm hide/show retains its renderer');
  assert.equal(engine.useFlow, true);
  assert.equal(satellite.refreshes, 2, 'warm visibility work remains owned by FramePool');
  controller.detachInterpolators();
}
console.log('ok lazy radar/satellite setup, latest mode/pause, warm reuse and other products');

{
  const h = harness(); const { controller, panes, state } = h;
  const radar = panes[0].framePools.radarLayer;
  radar.primary.setVisible(false); state.playing = false;
  controller.attachInterpolators();
  assert.equal(radar.interpolator, null);
  state.playing = true; radar.primary.setVisible(true);
  assert.equal(radar.interpActive, true, 'playback started before the first show is honoured');
  h.mode('off');
  for (const pane of panes) {
    for (const p of Object.values(pane.framePools)) {
      p.primary.setVisible(false); p.primary.setVisible(true);
      assert.equal(p.interpolator, null, 'turning off removes deferred creation too');
    }
  }
  h.mode('crossfade');
  assert.ok(radar.interpolator);
  assert.equal(radar.interpolator.useFlow, false);
  assert.equal(panes[1].framePools.radarLayer.interpolator, null, 'inactive panes stay detached');
  controller.detachInterpolators();
}
console.log('ok hidden first use after play, off/on and inactive panes');

{
  const h = harness(); const { controller, panes, state } = h;
  for (const count of [1, 2, 4, 1, 4, 2, 1]) {
    state.count = count;
    for (const pane of panes.slice(count)) controller.detachPaneInterpolators(pane);
    controller.attachInterpolators(); controller.attachInterpolators();
    for (const pane of panes) {
      const { radarLayer: radar, satelliteLayer: satellite } = pane.framePools;
      assert.equal(!!radar.interpolator, pane.index < count);
      assert.equal(satellite.interpolator, null);
      if (pane.index >= count) {
        satellite.primary.setVisible(true);
        assert.equal(satellite.interpolator, null, 'detached hidden pools cannot create on visibility changes');
        satellite.primary.setVisible(false);
      }
    }
  }
  const radar = panes[0].framePools.radarLayer;
  const old = radar.interpolator;
  controller.detachInterpolators();
  assert.equal(old.disposed, true);
  assert.equal(radar.interpActive, false);
  controller.attachInterpolators();
  assert.notEqual(radar.interpolator, old);
  controller.detachInterpolators();
}
console.log('ok repeated 1/2/4-pane changes, deferred listener removal and reattachment');

{
  const h = harness(); const {
    controller, panes, state, errors,
  } = h;
  state.count = 2; RadarInterpolator.failures = 1;
  controller.attachInterpolators();
  const radar = panes[0].framePools.radarLayer;
  assert.equal(radar.interpolator, null);
  assert.ok(panes[1].framePools.radarLayer.interpolator, 'one GPU failure must not abort other panes');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /pane 0 radarLayer.*GPU unavailable/);
  radar.primary.setVisible(false); radar.primary.setVisible(true);
  assert.ok(radar.interpolator, 'a later explicit show can retry');
  const satellite = panes[0].framePools.satelliteLayer;
  RadarInterpolator.failures = 1; satellite.primary.setVisible(true);
  assert.equal(satellite.interpolator, null);
  assert.equal(errors.length, 2);
  satellite.primary.setVisible(false); satellite.primary.setVisible(true);
  assert.ok(satellite.interpolator);
  controller.detachInterpolators();
}
console.log('ok isolated setup failure and retry on an explicit visibility change');
