if ('serviceWorker' in navigator && window.location.hostname !== 'localhost') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').then(function (registration) {
      console.log('ServiceWorker registration successful with scope: ', registration.scope);

      // Check for updates periodically
      setInterval(function () {
        registration.update();
      }, 600000); // Check every 10 minutes

      // Listen for updates
      registration.addEventListener('updatefound', function () {
        var newWorker = registration.installing;
        newWorker.addEventListener('statechange', function () {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New service worker is available — show a non-blocking notification
            var banner = document.createElement('div');
            banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;padding:12px;text-align:center;z-index:10000;font-family:sans-serif';
            banner.textContent = 'Uusi versio saatavilla. ';
            var btn = document.createElement('button');
            btn.textContent = 'Päivitä';
            btn.style.cssText = 'margin-left:12px;padding:6px 16px;background:#fff;color:#333;border:none;border-radius:4px;cursor:pointer';
            btn.onclick = function () { window.location.reload(); };
            banner.appendChild(btn);
            document.body.appendChild(banner);
          }
        });
      });
    }, function (err) {
      console.log('ServiceWorker registration failed: ', err);
    });
  });
}
