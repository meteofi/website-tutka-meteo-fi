// Service-worker bootstrap. Three responsibilities:
//
//   1. Register the worker and check for updates on a 10-minute heartbeat.
//   2. When a new worker reaches `installed`, show a one-shot "Päivitä"
//      banner. Tapping it posts SKIP_WAITING (handled by sw-skip-waiting.js
//      in the SW). Once the new worker becomes the controller we reload
//      exactly once.
//   3. Catch chunk-load 404s from a stale precached index.html that
//      references hashed bundle URLs no longer hosted; recover by
//      unregistering all SWs and reloading.
//
// The previous bootstrap had a race (listener attached inside the
// register().then) and trusted skipWaiting+clientsClaim to flip the
// controller mid-session — both wrong, both fixed here.

if ('serviceWorker' in navigator && window.location.hostname !== 'localhost') {
  // Self-heal must attach as early as possible — the chunk failure can
  // fire before the load event if a deferred bundle script 404s. Even so,
  // this catches everything that happens after sw-register.js runs, which
  // covers the dominant case (lazy chunks, late assets).
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
    // updateViaCache: 'none' is belt and suspenders. The default 'imports'
    // already bypasses HTTP cache for the main SW script during update
    // checks, but 'none' also covers any future importScripts() bundles.
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        console.log('ServiceWorker registered with scope:', registration.scope);

        let reloading = false;
        let bannerShown = false;

        function track(event, data) {
          if (typeof umami !== 'undefined') umami.track(event, data);
        }

        function showUpdateBanner(worker) {
          if (bannerShown || !worker) return;
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
            // The worker may have moved from 'installing' to 'waiting' by
            // the time the user clicks; postMessage works in either state.
            worker.postMessage({ type: 'SKIP_WAITING' });
          };
          banner.appendChild(btn);
          document.body.appendChild(banner);
        }

        // Banner trigger: a new worker reaches 'installed' AND there's
        // already a controller (so this isn't a first-ever install).
        function watchWorker(worker) {
          if (!worker) return;
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(worker);
            return;
          }
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(worker);
            }
          });
        }

        // Race-safe: check the registration's existing state first. If an
        // update was already detected before we registered our listeners
        // (browser auto-update before window.load), we still see it.
        if (registration.waiting) watchWorker(registration.waiting);
        if (registration.installing) watchWorker(registration.installing);
        registration.addEventListener('updatefound', () => {
          watchWorker(registration.installing);
        });

        // controllerchange fires when the new SW claims the page. With
        // clientsClaim off the trigger is our SKIP_WAITING -> skipWaiting
        // round-trip; reload once so the page renders against the new
        // precache cleanly.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloading) return;
          reloading = true;
          window.location.reload();
        });

        // 10-minute update poll while the tab stays open. registration.update()
        // returns a Promise; swallow rejections so a transient offline blip
        // doesn't surface in the console.
        setInterval(() => {
          registration.update().catch(() => {});
        }, 600000);
      })
      .catch((err) => {
        console.warn('ServiceWorker registration failed:', err);
      });
  });
}
