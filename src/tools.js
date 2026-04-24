import Overlay from 'ol/Overlay';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import {
  Circle as CircleStyle, Fill, Stroke, Style,
} from 'ol/style';
import { fromLonLat, transform } from 'ol/proj';
import { getDistance } from 'ol/sphere';
import LatLon from 'geodesy/latlon-spherical';
import Dms from 'geodesy/dms';

const PIN_STYLE = new Style({
  image: new CircleStyle({
    radius: 9,
    fill: new Fill({ color: '#12BCFA' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
});

const COMPASS_16_EN = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

const COMPASS_16_FI = [
  'pohjoinen', 'pohjois-koillinen', 'koillinen', 'itä-koillinen',
  'itä', 'itä-kaakko', 'kaakko', 'etelä-kaakko',
  'etelä', 'etelä-lounas', 'lounas', 'länsi-lounas',
  'länsi', 'länsi-luode', 'luode', 'pohjois-luode',
];

function compassIndex(deg) {
  return Math.round(((deg % 360) + 360) / 22.5) % 16;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(2)} km`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function buildCard() {
  const card = document.createElement('div');
  card.id = 'markerCard';
  card.className = 'marker-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Sijaintimerkki');
  card.innerHTML = `
    <div class="marker-card-head">
      <i class="material-icons marker-card-icon" aria-hidden="true">location_on</i>
      <span class="marker-card-title">Sijainti</span>
      <button type="button" class="marker-card-close" aria-label="Sulje sijaintimerkki">
        <i class="material-icons" aria-hidden="true">close</i>
      </button>
    </div>
    <div class="marker-card-grid">
      <button type="button" class="marker-coord" aria-label="Kopioi koordinaatit desimaalimuodossa">
        <span class="marker-coord-value">
          <span class="marker-coord-dm"></span>
          <i class="material-icons marker-coord-copy" aria-hidden="true">content_copy</i>
        </span>
        <span class="marker-coord-sub"></span>
      </button>
      <div class="marker-item marker-item-distance">
        <span class="marker-label">Etäisyys</span>
        <span class="marker-value"></span>
        <span class="marker-sub">linnuntietä</span>
      </div>
      <div class="marker-item marker-item-bearing">
        <span class="marker-label">Suunta</span>
        <span class="marker-value"></span>
        <span class="marker-sub"></span>
      </div>
    </div>
  `;
  return card;
}

export default function initTools({ map, getOwnPosition }) {
  const toolsLayer = new VectorLayer({
    source: new VectorSource(),
    style: PIN_STYLE,
  });
  map.addLayer(toolsLayer);

  const card = buildCard();
  document.body.appendChild(card);

  const overlay = new Overlay({
    element: card,
    positioning: 'bottom-center',
    offset: [0, -22],
    stopEvent: true,
    autoPan: {
      animation: { duration: 250 },
      margin: 20,
    },
  });
  map.addOverlay(overlay);

  const dmEl = card.querySelector('.marker-coord-dm');
  const ddEl = card.querySelector('.marker-coord-sub');
  const copyBtn = card.querySelector('.marker-coord');
  const distRow = card.querySelector('.marker-item-distance');
  const bearRow = card.querySelector('.marker-item-bearing');
  const distValue = distRow.querySelector('.marker-value');
  const bearValue = bearRow.querySelector('.marker-value');
  const bearSub = bearRow.querySelector('.marker-sub');
  const closeBtn = card.querySelector('.marker-card-close');

  let coord4326 = null;
  let pinFeature = null;
  let cardVisible = false;

  function updateCardVisibility() {
    if (pinFeature && coord4326 && cardVisible) {
      overlay.setPosition(fromLonLat(coord4326));
    } else {
      overlay.setPosition(undefined);
    }
  }

  function render() {
    if (!coord4326) return;

    dmEl.textContent = `${Dms.toLat(coord4326[1], 'dm', 2)}  ${Dms.toLon(coord4326[0], 'dm', 2)}`;
    ddEl.textContent = `${coord4326[1].toFixed(5)}° · ${coord4326[0].toFixed(5)}°`;

    const own = getOwnPosition();
    if (own && own.length === 2) {
      const meters = getDistance(coord4326, own);
      const p1 = new LatLon(own[1], own[0]);
      const p2 = new LatLon(coord4326[1], coord4326[0]);
      const brg = p1.initialBearingTo(p2);
      const idx = compassIndex(brg);
      distValue.textContent = formatDistance(meters);
      bearValue.textContent = `${brg.toFixed(0)}°`;
      bearSub.textContent = `${COMPASS_16_FI[idx]} (${COMPASS_16_EN[idx]})`;
      distRow.hidden = false;
      bearRow.hidden = false;
    } else {
      distRow.hidden = true;
      bearRow.hidden = true;
    }

    if (cardVisible) overlay.setPosition(fromLonLat(coord4326));
  }

  function dropOrMove(mapCoord) {
    coord4326 = transform(mapCoord, map.getView().getProjection(), 'EPSG:4326');
    if (pinFeature) {
      pinFeature.getGeometry().setCoordinates(mapCoord);
    } else {
      pinFeature = new Feature({ geometry: new Point(mapCoord) });
      toolsLayer.getSource().addFeature(pinFeature);
    }
    cardVisible = true;
    updateCardVisibility();
    render();
  }

  function remove() {
    if (pinFeature) toolsLayer.getSource().removeFeature(pinFeature);
    pinFeature = null;
    coord4326 = null;
    cardVisible = false;
    updateCardVisibility();
  }

  function toggleCard() {
    if (!pinFeature) return;
    cardVisible = !cardVisible;
    updateCardVisibility();
  }

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    remove();
  });

  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!coord4326) return;
    const text = `${coord4326[1].toFixed(5)}, ${coord4326[0].toFixed(5)}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    copyBtn.classList.add('marker-copied');
    setTimeout(() => copyBtn.classList.remove('marker-copied'), 800);
  });

  updateCardVisibility();

  return {
    dropOrMove,
    remove,
    toggleCard,
    refresh: render,
    getPinFeature: () => pinFeature,
  };
}
