// Service-worker bootstrap. Three responsibilities:
//
//   1. Register the worker and check for updates on a 10-minute heartbeat.
//   2. When a new worker reaches `installed`, show a one-shot "Päivitä"
//      banner. Tapping it does a plain `location.reload()` — the SW is
//      configured with `skipWaiting: true` so by the time the banner is
//      visible the new worker has already auto-activated. Reloading the
//      page creates a new client which picks up the new active worker.
//   3. Catch chunk-load 404s from a stale precached index.html that
//      references hashed bundle URLs no longer hosted; recover by
//      unregistering all SWs and reloading.
//
// The previous bootstrap had a real bug — the `updatefound` listener was
// attached only inside `register().then(...)`, so an update that had
// already moved past `installing` by the time the promise resolved was
// invisible to the page. This rewrite fixes that by also inspecting
// `registration.waiting` / `.installing` synchronously after register.

if ('serviceWorker' in navigator && window.location.hostname !== 'localhost') {
  // Whether THIS page navigation started under SW control. Captured
  // synchronously now: false on a first-ever visit (the page loaded
  // uncontrolled), true on a return visit. `navigator.serviceWorker
  // .controller` never changes until a `controllerchange` event fires,
  // so this is a race-free first-install vs. genuine-update
  // discriminator for the controllerchange handler. See issue #96.
  const hadController = !!navigator.serviceWorker.controller;

  // Self-heal must attach as early as possible — a deferred bundle 404
  // can fire its error event before window.load. We still miss anything
  // that errors before sw-register.js executes, but this catches lazy
  // fetches and late assets, which is the common failure shape.
  // Telemetry helper — loud about its own failures so we can see in
  // DevTools whether the event actually reached umami. The previous
  // silent guard hid the fact that none of the sw-* events were
  // surfacing even when the banner WAS shown.
  const swTrack = (event, data) => {
    if (typeof umami === 'undefined' || !umami || typeof umami.track !== 'function') {
      console.warn('[sw-register] umami not available for event:', event, data);
      return;
    }
    try {
      umami.track(event, data);
      console.log('[sw-register] telemetry sent:', event, data);
    } catch (err) {
      console.warn('[sw-register] umami.track threw for', event, err);
    }
  };

  window.addEventListener('error', (event) => {
    const { target } = event;
    if (!target || target.tagName !== 'SCRIPT') return;
    const src = target.src || '';
    if (!/\/(radar|openlayers|vendors|runtime)[.-][^/]*\.js$/.test(src)) return;
    console.warn('Chunk load failed, unregistering SWs and reloading:', src);
    swTrack('sw-chunk-load-error', { src });
    navigator.serviceWorker.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .finally(() => { window.location.reload(); });
  }, true);

  window.addEventListener('load', () => {
    // updateViaCache: 'none' is belt-and-suspenders. The default 'imports'
    // already bypasses HTTP cache for the main SW script; 'none' also
    // covers any future importScripts() bundles.
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        console.log('ServiceWorker registered with scope:', registration.scope);

        let bannerShown = false;
        let reloading = false;

        // The SW config has clientsClaim: true, so when a new worker
        // activates it immediately takes control of this tab and fires
        // `controllerchange`. Reload once at that point — but ONLY for a
        // genuine update (hadController), never the first-ever install,
        // where controllerchange just means clientsClaim() took control
        // of an already-current page. Belt-and-suspenders against
        // statechange timing quirks: even if the statechange handler
        // below misses 'installed' (e.g. WebKit dispatching events fast
        // enough that state already moved on), controllerchange on
        // activate is an unambiguous update signal.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloading) return;
          // First-ever visit: the page loaded uncontrolled and is
          // already running current code straight from the network.
          // Reloading here is pure waste — a full re-parse + re-boot
          // (OpenLayers, the OL Map, all FramePools) and re-issued
          // GetCapabilities fetches. Skip it; the precache is in place
          // for the NEXT navigation anyway.
          if (!hadController) {
            swTrack('sw-controllerchange-firstinstall');
            return;
          }
          reloading = true;
          swTrack('sw-controllerchange-reload');
          window.location.reload();
        });

        function showUpdateBanner() {
          if (bannerShown) return;
          bannerShown = true;
          swTrack('sw-update-shown');
          const banner = document.createElement('div');
          banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;padding:12px;text-align:center;z-index:10000;font-family:sans-serif';
          banner.textContent = 'Uusi versio saatavilla. ';
          const btn = document.createElement('button');
          btn.textContent = 'Päivitä';
          btn.style.cssText = 'margin-left:12px;padding:6px 16px;background:#fff;color:#333;border:none;border-radius:4px;cursor:pointer';
          btn.onclick = function () {
            swTrack('sw-update-clicked');
            // SW config has skipWaiting:true so the new worker is already
            // activated. A plain reload creates a new client which picks
            // up the new active worker and the fresh precache.
            window.location.reload();
          };
          banner.appendChild(btn);
          document.body.appendChild(banner);
        }

        // Banner trigger: a new worker reaches 'installed' AND there's
        // already a controller (so this isn't a first-ever install).
        function watchWorker(worker) {
          if (!worker) return;
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner();
            return;
          }
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        }

        // Race-safe: check the registration's existing state first. If
        // the browser auto-detected an update before window.load
        // resolved, .installing / .waiting will already be populated
        // and `updatefound` will never fire again for that worker.
        if (registration.waiting) watchWorker(registration.waiting);
        if (registration.installing) watchWorker(registration.installing);
        registration.addEventListener('updatefound', () => {
          watchWorker(registration.installing);
        });

        // 10-minute update poll while the tab stays open. Swallow rejections
        // so a transient offline blip doesn't surface in the console.
        setInterval(() => {
          registration.update().catch(() => {});
        }, 600000);
      })
      .catch((err) => {
        console.warn('ServiceWorker registration failed:', err);
      });
  });
}
