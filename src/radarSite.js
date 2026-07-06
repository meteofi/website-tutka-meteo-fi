import Overlay from 'ol/Overlay';
import { transform } from 'ol/proj';

// Radar-site drill-in: tap a radar-site marker → a small card anchored to the
// marker lets the user swap the main radar layer to that single site's WMS
// product (DBZH at its lowest elevation sweep) and back to the composite.
//
// The single-site layer animates exactly like a composite because the meteocore
// per-site layers (`<collection>/<quantity>`) carry a time dimension and the
// FramePool already syncs the ELEVATION param across its frame slots — so the
// only work here is swapping LAYERS + setting ELEVATION via the existing
// updateLayer path, then letting setTime drive the window as usual.
//
// State is kept module-local (`singleSite`); the invariant is:
//   singleSite != null  ⟺  radarLayer LAYERS is a site layer we set.
// Every transition sets or clears both ends, so the composite is always
// restorable. The one external path that could break it — restoreActiveLayer
// firing on the 60 s capabilities refresh — is neutralised by the caller via
// isSingleSiteActive().

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
function resolveProduct(feature) {
  const collection = feature.get('collection');
  if (!collection) return null;
  const quantity = pickQuantity(feature.get('quantities'));
  const angles = feature.get('elevation_angles');
  const elevation = Array.isArray(angles) && angles.length ? Math.min(...angles) : null;
  return { wmsLayer: `${collection}/${quantity}`, quantity, elevation };
}

function buildCard() {
  const card = document.createElement('div');
  card.id = 'radarSiteCard';
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
      <button type="button" class="radar-site-toggle" aria-pressed="false">Näytä tämä tutka</button>
    </div>
  `;
  return card;
}

export default function initRadarSite({
  map, radarLayer, updateLayer, setTime, drawCoverage = () => {}, clearCoverage = () => {},
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
  const toggleBtn = card.querySelector('.radar-site-toggle');
  const closeBtn = card.querySelector('.marker-card-close');

  // null in composite mode; otherwise { wmsLayer, elevation, savedComposite, feature }.
  let singleSite = null;
  // The feature whose card is currently shown (may differ from the active site).
  let cardFeature = null;

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

  function enterSingleSite(feature) {
    const product = resolveProduct(feature);
    if (!product) return;
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
    singleSite = {
      wmsLayer: product.wmsLayer,
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
    updateActiveIndicator();
    clearCoverage();
    renderToggle();
  }

  function renderToggle() {
    const product = cardFeature ? resolveProduct(cardFeature) : null;
    if (!product) {
      toggleBtn.disabled = true;
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.classList.remove('active');
      toggleBtn.textContent = 'Saatavilla vain verkossa';
      return;
    }
    const active = isSingleSiteActive() && getActiveWmsLayer() === product.wmsLayer;
    toggleBtn.disabled = false;
    toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    toggleBtn.classList.toggle('active', active);
    toggleBtn.textContent = active ? 'Piilota tämä tutka' : 'Näytä tämä tutka';
  }

  function openCardForFeature(feature) {
    cardFeature = feature;
    const name = feature.get('name') || 'Tutka-asema';
    const nod = feature.get('nod');
    nameEl.textContent = nod ? `${name} (${nod})` : name;

    const product = resolveProduct(feature);
    const country = (feature.get('country') || '').toUpperCase();
    const parts = [];
    if (product) {
      parts.push(product.quantity);
      if (product.elevation != null) parts.push(`${product.elevation}°`);
    }
    if (country) parts.push(country);
    subEl.textContent = parts.join(' · ');

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
    const product = resolveProduct(cardFeature);
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
    openCardForFeature,
    hideCard,
    exitSingleSite,
    isSingleSiteActive,
    getActiveWmsLayer,
    getSavedComposite,
    getActiveSiteLonLat,
  };
}
