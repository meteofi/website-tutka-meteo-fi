// Share tool ("Jaa näkymä"): captures the current map view as a PNG — frame
// timestamp and data attributions baked in — and hands it to the native
// share sheet (Web Share API) together with the app URL. Fallback ladder:
// image+url share → url-only share → download the PNG + copy the link.
//
// The capture is the official OpenLayers export-map example (composite every
// `.ol-layer canvas` honoring its opacity and CSS matrix transform), with
// three deliberate deviations:
//  - map.renderSync() instead of once('rendercomplete') + render():
//    rendercomplete waits for every in-flight tile/image load, which after a
//    pan can take seconds and burns the iOS transient-activation window that
//    navigator.share() requires. renderSync() returns with the layer
//    canvases up to date, and the sticky-frame stack guarantees they show
//    the last good image — by definition what the user is looking at.
//  - DPR-aware output (the example exports at CSS-pixel size).
//  - Multi-pane stitching: split-screen panes are composited side by side
//    from their live grid geometry.
// The opacity handling is also what makes interpolation capture work: the
// real radar layer is hidden at opacity 0 (_interpHiding) and skipped, while
// the warp layer draws at the user's opacity.

import dayjs from 'dayjs';

// Cap the export resolution; a DPR-3 phone doesn't need a 3× PNG.
const EXPORT_DPR_MAX = 2;

// Composite one pane's layer canvases into a fresh canvas at `dpr` × CSS
// pixels. Returns the canvas plus the pane's viewport rect for stitching.
function compositePane(pane, dpr) {
  const rect = pane.el.getBoundingClientRect();
  const out = document.createElement('canvas');
  out.width = Math.round(rect.width * dpr);
  out.height = Math.round(rect.height * dpr);
  const ctx = out.getContext('2d');

  // Opaque base so unloaded tile gaps don't come out transparent.
  let baseColor = getComputedStyle(pane.el).backgroundColor;
  if (!baseColor || baseColor === 'transparent' || baseColor === 'rgba(0, 0, 0, 0)') {
    baseColor = getComputedStyle(document.body).backgroundColor;
  }
  if (!baseColor || baseColor === 'transparent' || baseColor === 'rgba(0, 0, 0, 0)') {
    baseColor = '#111214';
  }
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, out.width, out.height);

  const canvases = pane.map.getViewport().querySelectorAll('.ol-layer canvas, canvas.ol-layer');
  canvases.forEach((canvas) => {
    if (!canvas.width || !canvas.height) return;
    const opacityStr = canvas.parentNode.style.opacity || canvas.style.opacity;
    const alpha = opacityStr === '' ? 1 : Number(opacityStr);
    if (!alpha) return;

    // The element's CSS transform maps canvas pixels to CSS pixels; prepend
    // the export scale so everything lands at output resolution.
    let matrix;
    const match = canvas.style.transform && canvas.style.transform.match(/^matrix\(([^(]*)\)$/);
    if (match) {
      matrix = match[1].split(',').map(Number);
    } else if (canvas.style.width.endsWith('px')) {
      matrix = [parseFloat(canvas.style.width) / canvas.width, 0, 0,
        parseFloat(canvas.style.height) / canvas.height, 0, 0];
    } else {
      matrix = [rect.width / canvas.width, 0, 0, rect.height / canvas.height, 0, 0];
    }
    if (!matrix.every(Number.isFinite)) {
      matrix = [rect.width / canvas.width, 0, 0, rect.height / canvas.height, 0, 0];
    }
    ctx.globalAlpha = alpha;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    const bg = canvas.parentNode.style.backgroundColor;
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(canvas, 0, 0);
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  return { canvas: out, rect };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      // toBlob throws a synchronous SecurityError on a tainted canvas.
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('toBlob returned null'));
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

// Desktop fallback, same ending as the OL export example: save the PNG.
function downloadFile(file) {
  const objectUrl = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

export default function initShare({
  button,
  getActivePanes,
  getFrameTimestamp,
  getAttributions,
  getShareUrl = () => window.location.href,
  onFeedback = () => {},
  onShared = () => {},
}) {
  // Append an info bar below the map (never covers data): frame time +
  // site name on the first line, data attributions on the second.
  function drawInfoBar(mapCanvas, dpr) {
    const pad = Math.round(10 * dpr);
    const f1 = Math.round(15 * dpr);
    const f2 = Math.round(11 * dpr);
    const gap = Math.round(4 * dpr);
    const barH = pad + f1 + gap + f2 + pad;
    const out = document.createElement('canvas');
    out.width = mapCanvas.width;
    out.height = mapCanvas.height + barH;
    const ctx = out.getContext('2d');
    ctx.drawImage(mapCanvas, 0, 0);
    ctx.fillStyle = '#111214';
    ctx.fillRect(0, mapCanvas.height, out.width, barH);
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `500 ${f1}px Roboto, sans-serif`;
    ctx.fillText(dayjs(getFrameTimestamp()).format('D.M.YYYY HH:mm'), pad, mapCanvas.height + pad);
    ctx.textAlign = 'right';
    ctx.fillText('tutka.meteo.fi', out.width - pad, mapCanvas.height + pad);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
    ctx.font = `${f2}px Roboto, sans-serif`;
    let attribution = getAttributions().join(' · ');
    while (attribution && ctx.measureText(attribution).width > out.width - 2 * pad) {
      attribution = `${attribution.slice(0, -2)}…`;
    }
    ctx.fillText(attribution, pad, mapCanvas.height + pad + f1 + gap);
    return out;
  }

  // Fully synchronous: renderSync + composite + stitch + info bar.
  function capture() {
    const dpr = Math.min(window.devicePixelRatio || 1, EXPORT_DPR_MAX);
    const comps = getActivePanes().map((pane) => {
      pane.map.renderSync();
      return compositePane(pane, dpr);
    });
    // Stitch panes by their live grid geometry — handles 1/2/4-pane and
    // portrait/landscape splits with no layout-specific code.
    const minX = Math.min(...comps.map((c) => c.rect.left));
    const minY = Math.min(...comps.map((c) => c.rect.top));
    const maxX = Math.max(...comps.map((c) => c.rect.right));
    const maxY = Math.max(...comps.map((c) => c.rect.bottom));
    const stitched = document.createElement('canvas');
    stitched.width = Math.round((maxX - minX) * dpr);
    stitched.height = Math.round((maxY - minY) * dpr);
    const ctx = stitched.getContext('2d');
    ctx.fillStyle = '#111214';
    ctx.fillRect(0, 0, stitched.width, stitched.height);
    for (const c of comps) {
      ctx.drawImage(c.canvas, Math.round((c.rect.left - minX) * dpr), Math.round((c.rect.top - minY) * dpr));
    }
    // Thin dividers on internal pane edges, mid-grey so they read on both
    // light and dark basemaps.
    const w = Math.max(1, Math.round(dpr));
    ctx.fillStyle = '#808080';
    for (const c of comps) {
      if (c.rect.left > minX + 1) {
        ctx.fillRect(Math.round((c.rect.left - minX) * dpr) - Math.floor(w / 2), 0, w, stitched.height);
      }
      if (c.rect.top > minY + 1) {
        ctx.fillRect(0, Math.round((c.rect.top - minY) * dpr) - Math.floor(w / 2), stitched.width, w);
      }
    }
    return drawInfoBar(stitched, dpr);
  }

  // Reentrancy guard: a second tap while the OS sheet is open would make
  // navigator.share() throw InvalidStateError.
  let busy = false;

  async function share() {
    if (busy) return;
    busy = true;
    try {
      const url = getShareUrl();
      let file = null;
      try {
        const ts = getFrameTimestamp();
        const blob = await canvasToBlob(capture());
        file = new File([blob], `tutka-${dayjs(ts).format('YYYYMMDD-HHmm')}.png`, { type: 'image/png' });
      } catch (err) {
        file = null; // tainted canvas / toBlob failure — degrade to link-only
      }

      if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Säätutka', url });
          onShared('web-share-files');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user cancelled
          // NotAllowedError / DataError / TypeError → try url-only
        }
      }
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Säätutka', url });
          onShared('web-share-url');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      if (file) downloadFile(file);
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (err) {
        copied = false;
      }
      if (file && copied) onFeedback('Kuva tallennettu, linkki kopioitu');
      else if (file) onFeedback('Kuva tallennettu');
      else if (copied) onFeedback('Linkki kopioitu');
      else {
        onFeedback('Jakaminen epäonnistui');
        return;
      }
      onShared(file ? 'download' : 'clipboard');
    } finally {
      busy = false;
    }
  }

  if (button) button.addEventListener('click', () => { share(); });

  return { share, capture };
}
