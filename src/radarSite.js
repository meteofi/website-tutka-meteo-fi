import Overlay from 'ol/Overlay';
import { transform } from 'ol/proj';

// Radar-site drill-in: tap a radar-site marker → a small card anchored to the
// marker lets the user swap the main radar layer to that single site's WMS
// product (DBZH at its lowest elevation sweep) and back to the composite.
// When the server advertises a disk-served `…-radar-single-<site>-…` variant
// of the site's pvol collection it is preferred (predictable latency); the
// card shows "Ladataan…" until the first site frame lands.
//
// The single-site layer animates exactly like a composite because the meteocore
// per-site layers (`<collection>/<quantity>`) carry a time dimension and the
// FramePool already syncs the ELEVATION param across its frame slots — so the
// only work here is swapping LAYERS + setting ELEVATION via the existing
// updateLayer path, then letting setTime drive the window as usual.
//
// State is kept per instance — one instance per pane, each bound to that
// pane's map and radar layer, so split panes drill in independently. The
// invariant is:
//   singleSite != null  ⟺  radarLayer LAYERS is a site layer we set.
// Every transition sets or clears both ends, so the composite is always
// restorable. The one external path that could break it — restoreActiveLayer
// firing on the 60 s capabilities refresh — is neutralised per pane by the
// caller via isSingleSiteActive().

// Radar moments offered in the drill-in card's selector, in display order:
// reflectivity (rain), horizontal radial velocity (Doppler), differential
// reflectivity. The card only shows the ones a given site actually advertises.
const SITE_MOMENTS = ['DBZH', 'VRADH', 'ZDR'];

// Choose the quantity to display: DBZH when the radar offers it (all FI + EE
// radars do), otherwise the first advertised quantity, with a final CSP
// fallback (present on every radar).
function pickQuantity(quantities) {
  if (Array.isArray(quantities) && quantities.length) {
    return quantities.includes('DBZH') ? 'DBZH' : quantities[0];
  }
  return 'CSP';
}

// Resolve a feature to its WMS product. Returns null when the feature has no
// `collection` (e.g. an older bundled fallback snapshot) — the card then shows
// the site but disables the toggle.
//
// Layer choice against the live capabilities registry (isLayerAdvertised is
// tri-state: true/false, or undefined while the radar GetCapabilities hasn't
// been parsed yet):
//   1. Prefer the disk-served `…-radar-single-<site>-pvol-<site>` variant
//      when advertised (MeteoCore contract: pvol streams from S3 and the
//      first touch can stall for seconds; single variants have predictable
//      latency). The variants are rolling out per site.
//   2. Otherwise use the pvol collection — but only when it's advertised or
//      the registry can't answer yet. The features catalog keeps a marker
//      while a radar is down for days (e.g. fipet 2026-07) and the WMS drops
//      its layers meanwhile; requesting it anyway just yields a
//      LayerNotDefined 400 for all 13 frames. Return `{ unavailable: true }`
//      instead so the card disables the toggle; the 60 s capabilities
//      refresh re-enables it automatically when the radar comes back.
function resolveProduct(feature, isLayerAdvertised, requestedQuantity) {
  const collection = feature.get('collection');
  if (!collection) return null;
  const quantity = requestedQuantity || pickQuantity(feature.get('quantities'));
  const angles = feature.get('elevation_angles');
  const elevation = Array.isArray(angles) && angles.length ? Math.min(...angles) : null;
  const m = /^([a-z]{2})-radar-pvol-([a-z0-9]+)$/.exec(collection);
  if (m) {
    const single = `${m[1]}-radar-single-${m[2]}-pvol-${m[2]}`;
    if (isLayerAdvertised(`${single}/${quantity}`) === true) {
      return { wmsLayer: `${single}/${quantity}`, quantity, elevation };
    }
  }
  if (isLayerAdvertised(`${collection}/${quantity}`) === false) {
    return { unavailable: true, quantity, elevation };
  }
  return { wmsLayer: `${collection}/${quantity}`, quantity, elevation };
}

function buildCard() {
  const card = document.createElement('div');
  card.className = 'marker-card radar-site-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Tutka-asema');
  card.innerHTML = `
    <div class="marker-card-head">
      <i class="material-icons marker-card-icon" aria-hidden="true">cell_tower</i>
      <span class="marker-card-title">Tutka-asema</span>
      <button type="button" class="marker-card-close" aria-label="Sulje">
        <i class="material-icons" aria-hidden="true">close</i>
      </button>
    </div>
    <div class="radar-site-body">
      <div class="radar-site-name"></div>
      <div class="radar-site-sub"></div>
      <div class="radar-site-moments" role="group" aria-label="Tutkasuure" hidden></div>
      <button type="button" class="radar-site-toggle" aria-pressed="false">Näytä tämä tutka</button>
    </div>
  `;
  return card;
}

export default function initRadarSite({
  map, radarLayer, radarSiteLayer, updateLayer, setTime,
  drawCoverage = () => {}, clearCoverage = () => {},
  // Whether the radar WMS currently advertises a layer name (wired to the
  // GetCapabilities-fed layerInfo registry in radar.js). Drives the
  // single-variant preference in resolveProduct; defaulting to false keeps
  // the pvol behavior when the capability data isn't available.
  isLayerAdvertised = () => false,
}) {
  const card = buildCard();
  document.body.appendChild(card);

  const overlay = new Overlay({
    element: card,
    positioning: 'bottom-center',
    offset: [0, -22],
    stopEvent: true,
    autoPan: { animation: { duration: 250 }, margin: 20 },
  });
  map.addOverlay(overlay);

  // Breathing ring over the currently-active single-site marker. The animation
  // is pure CSS (see .radar-site-pulse); JS only positions/clears the overlay.
  // pointer-events:none + stopEvent:false let taps pass through to the marker.
  const pulse = document.createElement('div');
  pulse.className = 'radar-site-pulse';
  pulse.setAttribute('aria-hidden', 'true');
  // Inner ring carries the CSS animation. OpenLayers writes `transform` on the
  // overlay element itself for positioning, so animating the outer element's
  // transform would fight OL — the inner span keeps the two independent.
  pulse.innerHTML = '<span class="radar-site-pulse-ring"></span>';
  const pulseOverlay = new Overlay({
    element: pulse,
    positioning: 'center-center',
    stopEvent: false,
  });
  map.addOverlay(pulseOverlay);

  const nameEl = card.querySelector('.radar-site-name');
  const subEl = card.querySelector('.radar-site-sub');
  const momentsEl = card.querySelector('.radar-site-moments');
  const toggleBtn = card.querySelector('.radar-site-toggle');
  const closeBtn = card.querySelector('.marker-card-close');

  // null in composite mode; otherwise
  // { wmsLayer, quantity, elevation, savedComposite, feature }.
  let singleSite = null;
  // The feature whose card is currently shown (may differ from the active site).
  let cardFeature = null;
  // The moment the card's selector currently points at. Session-ephemeral: reset
  // per card open (to the active site's moment if that site is shown, else DBZH),
  // matching the no-persist convention for single-site drill-in.
  let selectedQuantity = 'DBZH';

  // Moments this site advertises among the selectable set (catalog-driven).
  const availableMoments = (feature) => {
    const quantities = feature.get('quantities');
    if (!Array.isArray(quantities)) return [];
    return SITE_MOMENTS.filter((q) => quantities.includes(q));
  };

  // The quantity to request for a feature: the selected moment when this site
  // offers it, otherwise the default (DBZH / first advertised). Keeps the card
  // coherent when the selection carries over to a site that lacks that moment.
  const chosenQuantityFor = (feature) => {
    const avail = availableMoments(feature);
    if (avail.includes(selectedQuantity)) return selectedQuantity;
    return pickQuantity(feature.get('quantities'));
  };

  const isSingleSiteActive = () => singleSite !== null;
  const getActiveWmsLayer = () => (singleSite ? singleSite.wmsLayer : null);
  // The composite the drill-in will restore on exit. New split panes start on
  // this instead of the transient site product (see clonePaneDisplay).
  const getSavedComposite = () => (singleSite ? singleSite.savedComposite : null);
  // [lon, lat] (EPSG:4326) of the active single-site marker, or null in
  // composite mode. Used by the center-crosshair tool to aim its radar line.
  const getActiveSiteLonLat = () => {
    if (!singleSite || !singleSite.feature) return null;
    return transform(
      singleSite.feature.getGeometry().getCoordinates(),
      map.getView().getProjection(),
      'EPSG:4326',
    );
  };

  function getRadarParams() {
    return radarLayer.getSource().getParams();
  }

  // Anchor the breathing ring on the active site's marker (or hide it).
  function updateActiveIndicator() {
    if (singleSite && singleSite.feature) {
      pulseOverlay.setPosition(singleSite.feature.getGeometry().getCoordinates());
    } else {
      pulseOverlay.setPosition(undefined);
    }
  }

  // First-frame loading indicator. Entering a site swaps LAYERS, which
  // invalidates every frame slot; a pvol product's first uncached (site,
  // time) streams from S3 and can stall for seconds while the map keeps
  // showing the previous product's sticky frames (MeteoCore contract:
  // render behind a loading state, never block the UI on it). Watch the
  // displayed frame's source until it reports a load — re-attaching if
  // playback re-points the primary at another slot — and let renderToggle
  // show "Ladataan…" meanwhile. Safety timeout so an error path can never
  // wedge the label.
  let siteLoading = false;
  let loadWatch = null;

  function stopLoadWatch() {
    siteLoading = false;
    if (!loadWatch) return;
    loadWatch.detach();
    clearTimeout(loadWatch.timer);
    loadWatch = null;
  }

  function startLoadWatch() {
    stopLoadWatch();
    siteLoading = true;
    let source = null;
    const finish = () => { stopLoadWatch(); renderToggle(); };
    const detachSource = () => {
      if (!source) return;
      source.un('imageloadend', finish);
      source.un('imageloaderror', finish);
    };
    const attach = () => {
      detachSource();
      source = radarLayer.getSource();
      source.on('imageloadend', finish);
      source.on('imageloaderror', finish);
    };
    const onSourceChange = () => attach();
    radarLayer.on('change:source', onSourceChange);
    attach();
    loadWatch = {
      timer: setTimeout(finish, 20000),
      detach: () => {
        radarLayer.un('change:source', onSourceChange);
        detachSource();
      },
    };
  }

  function enterSingleSite(feature) {
    const product = resolveProduct(feature, isLayerAdvertised, chosenQuantityFor(feature));
    if (!product || product.unavailable) return;
    // Turning the radar on first means a drill-in from a hidden radar layer
    // shows the site rather than silently arming an invisible layer.
    if (!radarLayer.getVisible()) radarLayer.setVisible(true);
    // Keep the original composite as the restore target across a site→site
    // switch — never capture a site layer as the composite.
    const savedComposite = singleSite ? singleSite.savedComposite : getRadarParams().LAYERS;
    // Pass ELEVATION through updateLayer so the very first site request
    // carries the lowest sweep in the same params update as LAYERS.
    updateLayer(radarLayer, product.wmsLayer, {
      skipPersist: true, skipTracking: true, elevation: product.elevation,
    });
    setTime('keep');
    startLoadWatch();
    singleSite = {
      wmsLayer: product.wmsLayer,
      quantity: product.quantity,
      elevation: product.elevation,
      savedComposite,
      feature,
    };
    updateActiveIndicator();
    // Coverage rings are part of "showing this radar": redraw for the active
    // site (this also handles a site→site switch).
    drawCoverage(feature);
  }

  // restore=true swaps back to the saved composite; restore=false only clears
  // single-site state (used when another path — e.g. the radar long-press
  // menu — is itself about to set a new composite via updateLayer, which
  // clears ELEVATION in the same params update as its LAYERS swap).
  function exitSingleSite({ restore = true } = {}) {
    if (!singleSite) return;
    if (getRadarParams().LAYERS === singleSite.wmsLayer) {
      if (restore) {
        // Only skip the visibility step when the layer is already hidden (the
        // radar-off path), so restoring there doesn't re-show it. When visible
        // (toggle-off), let updateLayer run its normal canonical-page update.
        updateLayer(radarLayer, singleSite.savedComposite, {
          skipVisibility: !radarLayer.getVisible(),
          skipPersist: true,
          skipTracking: true,
        });
        setTime('keep');
      }
    }
    singleSite = null;
    stopLoadWatch();
    updateActiveIndicator();
    clearCoverage();
    renderToggle();
  }

  // Rebuild the moment segmented control for the shown feature. Hidden unless
  // the site advertises at least two selectable moments (a DBZH-only site keeps
  // the original single-toggle card). The active button reflects the chosen
  // moment — which may differ from `selectedQuantity` when the site lacks it.
  function renderMoments() {
    momentsEl.textContent = '';
    if (!cardFeature) { momentsEl.hidden = true; return; }
    const avail = availableMoments(cardFeature);
    if (avail.length < 2) { momentsEl.hidden = true; return; }
    momentsEl.hidden = false;
    const chosen = chosenQuantityFor(cardFeature);
    avail.forEach((q) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'radar-site-moment';
      btn.textContent = q;
      const on = q === chosen;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectMoment(q);
      });
      momentsEl.appendChild(btn);
    });
  }

  // Pick a moment. When the shown site is the one currently displayed, swap it
  // live (re-enter with the new quantity, re-arming the loading watch); when the
  // site is off, this only arms the moment the toggle will show.
  function selectMoment(q) {
    if (!cardFeature || q === selectedQuantity) return;
    selectedQuantity = q;
    if (isSingleSiteActive() && singleSite.feature === cardFeature) {
      enterSingleSite(cardFeature);
    }
    renderMoments();
    renderToggle();
  }

  function renderToggle() {
    const product = cardFeature
      ? resolveProduct(cardFeature, isLayerAdvertised, chosenQuantityFor(cardFeature)) : null;
    if (!product || product.unavailable) {
      toggleBtn.disabled = true;
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.classList.remove('active', 'loading');
      // Down radar (marker present, WMS layers gone) vs. offline snapshot
      // feature that never had a collection.
      toggleBtn.textContent = product ? 'Ei tutkakuvaa juuri nyt' : 'Saatavilla vain verkossa';
      return;
    }
    const active = isSingleSiteActive() && getActiveWmsLayer() === product.wmsLayer;
    const loading = active && siteLoading;
    toggleBtn.disabled = false;
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggleBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    toggleBtn.classList.toggle('active', active);
    toggleBtn.classList.toggle('loading', loading);
    toggleBtn.textContent = active ? (loading ? 'Ladataan…' : 'Piilota tämä tutka') : 'Näytä tämä tutka';
  }

  // Hit-test a map pixel against this pane's radar-site markers. The
  // layer-aware lookup distinguishes radar sites from other point markers
  // (e.g. airfields) regardless of z-order; hitTolerance enlarges the tap
  // target around the small radar symbol (touch-friendly) without changing
  // how the marker is drawn. Returns the feature or null.
  function findSiteAtPixel(pixel) {
    if (!radarSiteLayer || !radarSiteLayer.getVisible()) return null;
    let hit = null;
    map.forEachFeatureAtPixel(pixel, (f, layer) => {
      if (layer === radarSiteLayer) { hit = f; return true; }
      return false;
    }, { hitTolerance: 12 });
    return hit;
  }

  function openCardForFeature(feature) {
    cardFeature = feature;
    // Reset the selector to the shown site's live moment if it's the active
    // one, otherwise to the DBZH default. The moment is now surfaced by the
    // selector, so drop it from the sub-line (elevation + country remain).
    selectedQuantity = (isSingleSiteActive() && singleSite.feature === feature)
      ? singleSite.quantity : 'DBZH';

    const name = feature.get('name') || 'Tutka-asema';
    const nod = feature.get('nod');
    nameEl.textContent = nod ? `${name} (${nod})` : name;

    const product = resolveProduct(feature, isLayerAdvertised, chosenQuantityFor(feature));
    const country = (feature.get('country') || '').toUpperCase();
    const parts = [];
    if (product && product.elevation != null) parts.push(`${product.elevation}°`);
    if (country) parts.push(country);
    subEl.textContent = parts.join(' · ');

    renderMoments();
    renderToggle();
    overlay.setPosition(feature.getGeometry().getCoordinates());
  }

  function hideCard() {
    overlay.setPosition(undefined);
    cardFeature = null;
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!cardFeature || toggleBtn.disabled) return;
    const product = resolveProduct(cardFeature, isLayerAdvertised, chosenQuantityFor(cardFeature));
    const active = isSingleSiteActive() && getActiveWmsLayer() === product.wmsLayer;
    if (active) {
      exitSingleSite({ restore: true });
    } else {
      enterSingleSite(cardFeature);
      renderToggle();
    }
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideCard();
  });

  return {
    findSiteAtPixel,
    openCardForFeature,
    hideCard,
    exitSingleSite,
    isSingleSiteActive,
    getActiveWmsLayer,
    getSavedComposite,
    getActiveSiteLonLat,
  };
}
