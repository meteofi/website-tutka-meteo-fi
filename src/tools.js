import Overlay from 'ol/Overlay';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
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

const T1_CIRCLE = new CircleStyle({
  radius: 9,
  fill: new Fill({ color: '#12BCFA' }),
  stroke: new Stroke({ color: '#ffffff', width: 2 }),
});

const T2_CIRCLE = new CircleStyle({
  radius: 9,
  fill: new Fill({ color: '#E255C7' }),
  stroke: new Stroke({ color: '#ffffff', width: 2 }),
});

const LINE_STYLE = new Style({
  stroke: new Stroke({
    color: 'rgba(18, 188, 250, 0.85)',
    width: 2,
    lineDash: [6, 4],
  }),
});

function pinLabelStyle(circle, bg, fg, text) {
  return new Style({
    image: circle,
    text: new Text({
      text,
      font: 'bold 11px Roboto, sans-serif',
      offsetY: -22,
      textAlign: 'center',
      fill: new Fill({ color: fg }),
      backgroundFill: new Fill({ color: bg }),
      padding: [2, 6, 2, 6],
    }),
  });
}

function lineLabelStyle(text) {
  return new Style({
    stroke: new Stroke({
      color: 'rgba(18, 188, 250, 0.85)',
      width: 2,
      lineDash: [6, 4],
    }),
    text: new Text({
      text,
      placement: 'line',
      font: 'bold 12px Roboto, sans-serif',
      fill: new Fill({ color: '#ffffff' }),
      // Outline so the label stays legible over any radar/map colour
      stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.85)', width: 3 }),
      overflow: true,
    }),
  });
}

const COMPASS_16_EN = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

function compassIndex(deg) {
  return Math.round(((deg % 360) + 360) / 22.5) % 16;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

function formatHHMM(ms) {
  return new Date(ms).toLocaleTimeString('fi', { hour: '2-digit', minute: '2-digit' });
}

function buildMarkerCard() {
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

export default function initTools({ map, getOwnPosition, getFrameTimestamp }) {
  // ---------------------------------------------------------------
  // Location marker (ambient, non-modal)
  // ---------------------------------------------------------------
  const markerLayer = new VectorLayer({
    source: new VectorSource(),
    style: PIN_STYLE,
  });
  map.addLayer(markerLayer);

  const markerCard = buildMarkerCard();
  document.body.appendChild(markerCard);

  const markerOverlay = new Overlay({
    element: markerCard,
    positioning: 'bottom-center',
    offset: [0, -22],
    stopEvent: true,
    autoPan: {
      animation: { duration: 250 },
      margin: 20,
    },
  });
  map.addOverlay(markerOverlay);

  const dmEl = markerCard.querySelector('.marker-coord-dm');
  const ddEl = markerCard.querySelector('.marker-coord-sub');
  const copyBtn = markerCard.querySelector('.marker-coord');
  const distRow = markerCard.querySelector('.marker-item-distance');
  const bearRow = markerCard.querySelector('.marker-item-bearing');
  const distValue = distRow.querySelector('.marker-value');
  const bearValue = bearRow.querySelector('.marker-value');
  const bearSub = bearRow.querySelector('.marker-sub');
  const markerCloseBtn = markerCard.querySelector('.marker-card-close');

  let markerCoord4326 = null;
  let markerFeature = null;
  let markerCardVisible = false;

  function updateMarkerCardVisibility() {
    if (markerFeature && markerCoord4326 && markerCardVisible) {
      markerOverlay.setPosition(fromLonLat(markerCoord4326));
    } else {
      markerOverlay.setPosition(undefined);
    }
  }

  function renderMarker() {
    if (!markerCoord4326) return;
    dmEl.textContent = `${Dms.toLat(markerCoord4326[1], 'dm', 2)}  ${Dms.toLon(markerCoord4326[0], 'dm', 2)}`;
    ddEl.textContent = `${markerCoord4326[1].toFixed(5)}° · ${markerCoord4326[0].toFixed(5)}°`;

    const own = getOwnPosition();
    if (own && own.length === 2) {
      const meters = getDistance(markerCoord4326, own);
      const p1 = new LatLon(own[1], own[0]);
      const p2 = new LatLon(markerCoord4326[1], markerCoord4326[0]);
      const brg = p1.initialBearingTo(p2);
      distValue.textContent = formatDistance(meters);
      bearValue.textContent = `${brg.toFixed(0)}°`;
      bearSub.textContent = COMPASS_16_EN[compassIndex(brg)];
      distRow.hidden = false;
      bearRow.hidden = false;
    } else {
      distRow.hidden = true;
      bearRow.hidden = true;
    }
    if (markerCardVisible) markerOverlay.setPosition(fromLonLat(markerCoord4326));
  }

  function dropOrMoveMarker(mapCoord) {
    markerCoord4326 = transform(mapCoord, map.getView().getProjection(), 'EPSG:4326');
    if (markerFeature) {
      markerFeature.getGeometry().setCoordinates(mapCoord);
    } else {
      markerFeature = new Feature({ geometry: new Point(mapCoord) });
      markerLayer.getSource().addFeature(markerFeature);
    }
    markerCardVisible = true;
    updateMarkerCardVisibility();
    renderMarker();
  }

  function removeMarker() {
    if (markerFeature) markerLayer.getSource().removeFeature(markerFeature);
    markerFeature = null;
    markerCoord4326 = null;
    markerCardVisible = false;
    updateMarkerCardVisibility();
  }

  function toggleMarkerCard() {
    if (!markerFeature) return;
    markerCardVisible = !markerCardVisible;
    updateMarkerCardVisibility();
  }

  markerCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeMarker();
  });

  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!markerCoord4326) return;
    const text = `${markerCoord4326[1].toFixed(5)}, ${markerCoord4326[0].toFixed(5)}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    copyBtn.classList.add('marker-copied');
    setTimeout(() => copyBtn.classList.remove('marker-copied'), 800);
  });

  updateMarkerCardVisibility();

  // ---------------------------------------------------------------
  // Measurement tool (modal: Mittaa)
  // ---------------------------------------------------------------
  const measureLayer = new VectorLayer({
    source: new VectorSource(),
    // Per-feature styles are set via setStyle() in handleMeasureTap so the
    // pin labels can carry their captured timestamp. The line feature has no
    // own style and falls back to this layer default.
    style: (feat) => (feat.get('kind') === 'line' ? LINE_STYLE : undefined),
  });
  map.addLayer(measureLayer);

  const measureCard = document.getElementById('measureCard');
  const toolChip = document.getElementById('toolChip');
  const toolChipHint = toolChip ? toolChip.querySelector('.chip-hint') : null;
  const toolChipClose = toolChip ? toolChip.querySelector('.chip-close') : null;
  const menuButtonEl = document.getElementById('menuButton');

  let measureArmed = false;
  let measureState = 'idle'; // 'idle' | 'awaiting-t1' | 'awaiting-t2' | 'showing-result'
  let t1Feature = null;
  let t2Feature = null;
  let lineFeature = null;
  let t1Coord4326 = null;
  let t2Coord4326 = null;
  let t1Ts = null;
  let t2Ts = null;

  const mv = measureCard ? {
    distance: measureCard.querySelector('.measure-distance .measure-value'),
    distanceSub: measureCard.querySelector('.measure-distance .measure-sub'),
    bearing: measureCard.querySelector('.measure-bearing .measure-value'),
    bearingSub: measureCard.querySelector('.measure-bearing .measure-sub'),
    time: measureCard.querySelector('.measure-time .measure-value'),
    timeSub: measureCard.querySelector('.measure-time .measure-sub'),
    velocity: measureCard.querySelector('.measure-velocity .measure-value'),
    velocitySub: measureCard.querySelector('.measure-velocity .measure-sub'),
    timeRow: measureCard.querySelector('.measure-time'),
    velocityRow: measureCard.querySelector('.measure-velocity'),
  } : null;

  function setChipHint(txt) {
    if (toolChipHint) toolChipHint.textContent = txt ? `· ${txt}` : '';
  }

  function clearMeasureFeatures() {
    const src = measureLayer.getSource();
    if (t1Feature) { src.removeFeature(t1Feature); t1Feature = null; }
    if (t2Feature) { src.removeFeature(t2Feature); t2Feature = null; }
    if (lineFeature) { src.removeFeature(lineFeature); lineFeature = null; }
    t1Coord4326 = null;
    t2Coord4326 = null;
    t1Ts = null;
    t2Ts = null;
    if (measureCard) measureCard.hidden = true;
  }

  function drawMeasureLine() {
    if (!t1Feature || !t2Feature) return;
    const src = measureLayer.getSource();
    if (lineFeature) src.removeFeature(lineFeature);
    lineFeature = new Feature({
      kind: 'line',
      geometry: new LineString([
        t1Feature.getGeometry().getCoordinates(),
        t2Feature.getGeometry().getCoordinates(),
      ]),
    });
    src.addFeature(lineFeature);
  }

  function renderMeasurement() {
    if (!mv || !t1Coord4326 || !t2Coord4326) return;
    const meters = getDistance(t1Coord4326, t2Coord4326);
    const p1 = new LatLon(t1Coord4326[1], t1Coord4326[0]);
    const p2 = new LatLon(t2Coord4326[1], t2Coord4326[0]);
    const brg = p1.initialBearingTo(p2);

    mv.distance.textContent = formatDistance(meters);
    mv.bearing.textContent = `${brg.toFixed(0)}°`;
    mv.bearingSub.textContent = COMPASS_16_EN[compassIndex(brg)];

    const dtMs = (t1Ts != null && t2Ts != null) ? t2Ts - t1Ts : 0;
    const absDt = Math.abs(dtMs);
    const hasTime = absDt >= 60000; // at least 1 minute to be meaningful

    if (hasTime) {
      const mins = Math.round(absDt / 60000);
      mv.time.textContent = `${mins} min`;
      mv.timeSub.textContent = `${formatHHMM(t1Ts)} → ${formatHHMM(t2Ts)}`;
      const ms = meters / (absDt / 1000);
      mv.velocity.textContent = `${ms.toFixed(1)} m/s`;
      mv.velocitySub.textContent = `${(ms * 3.6).toFixed(1)} km/h`;
    }
    mv.timeRow.hidden = !hasTime;
    mv.velocityRow.hidden = !hasTime;
    if (lineFeature) lineFeature.setStyle(lineLabelStyle(formatDistance(meters)));
  }

  function armMeasure() {
    if (measureArmed) return;
    measureArmed = true;
    measureState = 'awaiting-t1';
    clearMeasureFeatures();
    // Hide marker card while measuring (keep the pin; restore card on disarm)
    if (markerCardVisible) markerOverlay.setPosition(undefined);
    if (toolChip) toolChip.hidden = false;
    setChipHint('napauta karttaa');
    if (menuButtonEl) menuButtonEl.classList.add('tool-armed');
  }

  function disarmMeasure() {
    if (!measureArmed) return;
    measureArmed = false;
    measureState = 'idle';
    clearMeasureFeatures();
    if (toolChip) toolChip.hidden = true;
    if (menuButtonEl) menuButtonEl.classList.remove('tool-armed');
    // Restore marker card if the pin is still there and it was visible before
    if (markerFeature && markerCoord4326 && markerCardVisible) {
      markerOverlay.setPosition(fromLonLat(markerCoord4326));
    }
  }

  function handleMeasureTap(mapCoord) {
    const src = measureLayer.getSource();
    const coord4326 = transform(mapCoord, map.getView().getProjection(), 'EPSG:4326');
    const ts = typeof getFrameTimestamp === 'function' ? getFrameTimestamp() : Date.now();

    if (measureState === 'awaiting-t1' || measureState === 'showing-result') {
      // First placement, or tap 3 → start new pair
      if (t1Feature) src.removeFeature(t1Feature);
      if (t2Feature) src.removeFeature(t2Feature);
      if (lineFeature) src.removeFeature(lineFeature);
      t1Feature = new Feature({ kind: 't1', geometry: new Point(mapCoord) });
      t1Feature.setStyle(pinLabelStyle(T1_CIRCLE, '#12BCFA', '#06202a', `T1 · ${formatHHMM(ts)}`));
      t2Feature = null;
      lineFeature = null;
      src.addFeature(t1Feature);
      t1Coord4326 = coord4326;
      t1Ts = ts;
      t2Coord4326 = null;
      t2Ts = null;
      if (measureCard) measureCard.hidden = true;
      measureState = 'awaiting-t2';
      setChipHint('napauta toista pistettä');
    } else if (measureState === 'awaiting-t2') {
      t2Feature = new Feature({ kind: 't2', geometry: new Point(mapCoord) });
      t2Feature.setStyle(pinLabelStyle(T2_CIRCLE, '#E255C7', '#2a001f', `T2 · ${formatHHMM(ts)}`));
      src.addFeature(t2Feature);
      t2Coord4326 = coord4326;
      t2Ts = ts;
      drawMeasureLine();
      renderMeasurement();
      if (measureCard) measureCard.hidden = false;
      measureState = 'showing-result';
      setChipHint('napauta uuteen aloittaaksesi alusta');
    }
  }

  // Measurement action wires
  if (toolChipClose) {
    toolChipClose.addEventListener('click', (e) => {
      e.stopPropagation();
      disarmMeasure();
    });
  }

  if (measureCard) {
    const resetBtn = measureCard.querySelector('.measure-action-reset');
    const copyMeasureBtn = measureCard.querySelector('.measure-action-copy');
    const doneBtns = measureCard.querySelectorAll('.measure-action-done');

    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearMeasureFeatures();
        measureState = 'awaiting-t1';
        setChipHint('napauta karttaa');
      });
    }
    if (copyMeasureBtn) {
      copyMeasureBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!t1Coord4326 || !t2Coord4326) return;
        const meters = getDistance(t1Coord4326, t2Coord4326);
        const p1 = new LatLon(t1Coord4326[1], t1Coord4326[0]);
        const p2 = new LatLon(t2Coord4326[1], t2Coord4326[0]);
        const brg = p1.initialBearingTo(p2);
        const dtMs = (t1Ts != null && t2Ts != null) ? t2Ts - t1Ts : 0;
        const absDt = Math.abs(dtMs);
        const lines = [
          'Mittaus',
          `T1: ${t1Coord4326[1].toFixed(5)}, ${t1Coord4326[0].toFixed(5)}`,
          `T2: ${t2Coord4326[1].toFixed(5)}, ${t2Coord4326[0].toFixed(5)}`,
          `Etäisyys: ${formatDistance(meters)}`,
          `Suunta: ${brg.toFixed(0)}° ${COMPASS_16_EN[compassIndex(brg)]}`,
        ];
        if (absDt >= 60000) {
          const mins = Math.round(absDt / 60000);
          const ms = meters / (absDt / 1000);
          lines.push(`Aika: ${mins} min (${formatHHMM(t1Ts)} → ${formatHHMM(t2Ts)})`);
          lines.push(`Nopeus: ${ms.toFixed(1)} m/s (${(ms * 3.6).toFixed(1)} km/h)`);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
        }
        copyMeasureBtn.classList.add('measure-btn-copied');
        setTimeout(() => copyMeasureBtn.classList.remove('measure-btn-copied'), 800);
      });
    }
    doneBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        disarmMeasure();
      });
    });
  }

  // Esc disarms measurement
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && measureArmed) {
      disarmMeasure();
    }
  });

  return {
    // marker
    dropOrMove: dropOrMoveMarker,
    remove: removeMarker,
    toggleCard: toggleMarkerCard,
    refresh: renderMarker,
    getPinFeature: () => markerFeature,
    // measurement
    arm: armMeasure,
    disarm: disarmMeasure,
    isArmed: () => measureArmed,
    handleMeasureTap,
  };
}
