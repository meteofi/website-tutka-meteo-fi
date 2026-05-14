/* eslint-env serviceworker */
/* eslint-disable no-restricted-globals */ // `self` is the ServiceWorkerGlobalScope here
// Imported by the Workbox-generated sw.js (see webpack.config.js
// `importScripts`). Pairs with sw-register.js: when the page detects an
// installed-but-waiting worker and the user clicks Päivitä, the page
// posts {type:'SKIP_WAITING'} to that worker; we then call skipWaiting()
// so the SW activates, fires `controllerchange` in the page, and the
// page reloads itself into the new version.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
