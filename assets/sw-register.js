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
  // Self-heal must attach as early as possible — a deferred bundle 404
  // can fire its error event before window.load. We still miss anything
  // that errors before sw-register.js executes, but this catches lazy
  // fetches and late assets, which is the common failure shape.
  window.addEventListener('error', (event) => {
    const { target } = event;
    if (!target || target.tagName !== 'SCRIPT') return;
    const src = target.src || '';
    if (!/\/(radar|openlayers|vendors|runtime)[.-][^/]*\.js$/.test(src)) return;
    console.warn('Chunk load failed, unregistering SWs and reloading:', src);
    if (typeof umami !== 'undefined') umami.track('sw-chunk-load-error', { src });
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

        // The SW config has clientsClaim: true, so when the new worker
        // activates it immediately takes control of this tab and fires
        // `controllerchange`. Reload exactly once at that point — gives
        // a fresh navigation served by the new precache. Belt-and-
        // suspenders against statechange timing quirks: even if the
        // statechange handler below misses 'installed' (e.g. WebKit
        // dispatching events fast enough that state already moved on),
        // the controllerchange firing on activate is unambiguous.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloading) return;
          reloading = true;
          if (typeof umami !== 'undefined') {
            umami.track('sw-controllerchange-reload');
          }
          window.location.reload();
        });

        function track(event, data) {
          if (typeof umami !== 'undefined') umami.track(event, data);
        }

        function showUpdateBanner() {
          if (bannerShown) return;
          bannerShown = true;
          track('sw-update-shown');
          const banner = document.createElement('div');
          banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;padding:12px;text-align:center;z-index:10000;font-family:sans-serif';
          banner.textContent = 'Uusi versio saatavilla. ';
          const btn = document.createElement('button');
          btn.textContent = 'Päivitä';
          btn.style.cssText = 'margin-left:12px;padding:6px 16px;background:#fff;color:#333;border:none;border-radius:4px;cursor:pointer';
          btn.onclick = function () {
            track('sw-update-clicked');
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
