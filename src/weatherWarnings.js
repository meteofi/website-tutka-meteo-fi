import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import {
  Fill, Stroke, Style, Text,
} from 'ol/style';
import {
  fetchWarningSnapshot, inWarningWindow, LEVELS, WARNING_TYPES, warningLanguageRank,
} from './warnings/warningData';
import createWarningSheet from './warnings/warningSheet';

const REFRESH_MS = 5 * 60 * 1000;
const format = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

// Wall-clock warnings: never routed through setTime/FramePool. One complete
// snapshot and spatial index serve all panes; panning never makes a request.
export default function initWeatherWarnings() {
  const source = new VectorSource({ attributions: 'Varoitukset © Meteoalarm / kansalliset sääpalvelut' });
  let records = [];
  let features = new Map();
  let enabled = false;
  let enabledTypes = new Set();
  let upcoming = true;
  let allAreas = false;
  let selectedIds = [];
  let currentMap = null;
  let lastSuccess = 0;
  let lastAttempt = 0;
  let failed = false;
  let request = null;
  let timer = null;
  let shownKey = '';
  let selectedKey = '';

  const sheet = createWarningSheet({
    onWindow(value) { upcoming = value; selectedIds = []; render(); },
    onScope(value) { allAreas = value; selectedIds = []; render(); },
    onRetry: () => refresh(),
    onLocate(id) {
      const feature = features.get(id);
      if (!feature || !currentMap) return;
      selectedIds = [id];
      const size = currentMap.getSize();
      currentMap.getView().fit(feature.getGeometry().getExtent(), {
        size,
        padding: [Math.min(100, size[1] * 0.2), size[0] * 0.1, Math.min(170, size[1] * 0.25), size[0] * 0.1],
        maxZoom: 9,
        duration: 350,
      });
      render();
    },
  });

  function render() {
    const now = Date.now();
    const visible = records.filter((warning) => enabledTypes.has(warning.type) && inWarningWindow(warning, now, upcoming));
    const key = visible.map((w) => `${w.id}:${w.start > now}`).join('|');
    if (key !== shownKey) {
      shownKey = key;
      source.clear(true);
      source.addFeatures(visible.map((w) => features.get(w.id)));
      visible.forEach((w) => features.get(w.id).set('future', w.start > now));
    }
    const selection = selectedIds.join('|');
    if (selection !== selectedKey) {
      selectedKey = selection;
      features.forEach((feature, id) => feature.set('selected', selectedIds.includes(id)));
    }
    const extent = currentMap?.getView().calculateExtent(currentMap.getSize());
    const inView = extent ? new Set(source.getFeaturesInExtent(extent)
      .filter((f) => f.getGeometry().intersectsExtent(extent)).map((f) => f.getId())) : new Set();
    const warnings = visible.filter((w) => allAreas || inView.has(w.id) || selectedIds.includes(w.id))
      .sort((a, b) => Number(selectedIds.includes(b.id)) - Number(selectedIds.includes(a.id))
        || Number(a.start > now) - Number(b.start > now) || b.level - a.level || a.start - b.start
        || warningLanguageRank(a.language) - warningLanguageRank(b.language)
        || a.area.localeCompare(b.area, 'fi'));
    sheet.update({
      enabled,
      enabledTypes,
      warnings,
      count: inView.size,
      highestLevel: visible.filter((w) => inView.has(w.id)).reduce((level, w) => Math.max(level, w.level), 0),
      now,
      loading: !!request,
      failed,
      lastSuccess,
      upcoming,
      allAreas,
      selectedIds,
    });
  }

  async function refresh() {
    if (!enabled || request) return;
    const controller = new AbortController();
    request = controller;
    lastAttempt = Date.now();
    const timeout = setTimeout(() => controller.abort(), 45000);
    render();
    try {
      const snapshot = await fetchWarningSnapshot({ signal: controller.signal });
      const nextFeatures = new Map();
      snapshot.forEach((warning) => {
        const feature = format.readFeature({
          type: 'Feature',
          id: warning.id,
          geometry: warning.geometry,
          properties: { level: warning.level, type: warning.type },
        });
        const geometry = feature.getGeometry();
        if (!geometry.getExtent().every(Number.isFinite) || !(geometry.getArea() > 0)) {
          throw new Error('Invalid warning geometry');
        }
        // Label every polygon part, using guaranteed interior points. Keep
        // geometry cached; styles run often on a moving mobile map.
        feature.set('anchor', geometry.getType() === 'Polygon'
          ? geometry.getInteriorPoint() : geometry.getInteriorPoints());
        nextFeatures.set(warning.id, feature);
      });
      if (request !== controller || !enabled) return;
      records = snapshot;
      features = nextFeatures;
      selectedIds = selectedIds.filter((id) => features.has(id));
      shownKey = null;
      selectedKey = null;
      lastSuccess = Date.now();
      failed = false;
    } catch (error) {
      if (request === controller && enabled) failed = true;
    } finally {
      clearTimeout(timeout);
      if (request === controller) {
        request = null;
        render();
      }
    }
  }

  function makeStyle(dark) {
    const cache = new Map();
    return (feature) => {
      const type = feature.get('type');
      const level = feature.get('level');
      const future = feature.get('future');
      const selected = feature.get('selected');
      const key = `${type}:${level}:${future}:${selected}`;
      if (!cache.has(key)) {
        const { color, ink, marks } = LEVELS[level];
        const strokeColor = dark ? color : ink;
        const zIndex = level + (selected ? 10 : 0);
        cache.set(key, [
          new Style({ zIndex, stroke: new Stroke({ color: dark ? '#151820cc' : '#ffffffdd', width: selected ? 7 : 5 }) }),
          new Style({
            zIndex,
            fill: new Fill({ color: `${color}${future ? '0c' : '1c'}` }),
            stroke: new Stroke({ color: strokeColor, width: selected ? 3 : 2, lineDash: future ? [7, 6] : undefined }),
          }),
          new Style({
            zIndex: zIndex + 20,
            geometry: (f) => f.get('anchor'),
            text: new Text({
              text: `${WARNING_TYPES[type].symbol} ${marks}`,
              font: 'bold 13px sans-serif',
              padding: [5, 7, 5, 7],
              fill: new Fill({ color: '#191b22' }),
              backgroundFill: new Fill({ color }),
              backgroundStroke: new Stroke({ color: '#191b22', width: 1.5 }),
              overflow: false,
            }),
          }),
        ]);
      }
      return cache.get(key);
    };
  }
  const styleLight = makeStyle(false);
  const styleDark = makeStyle(true);

  function catchUp() {
    if (!enabled || document.visibilityState === 'hidden') return;
    render(); // expire/change upcoming styling even during an outage
    if (Date.now() - lastAttempt >= (failed ? 60000 : REFRESH_MS)) refresh();
  }
  document.addEventListener('visibilitychange', catchUp);
  window.addEventListener('online', () => { if (enabled) refresh(); });

  return {
    styleLight,
    styleDark,
    createPaneLayer: () => new VectorLayer({
      source, visible: false, style: styleLight, declutter: 'weather-warnings',
    }),
    attachPane(map, layer) {
      if (!currentMap) currentMap = map;
      map.on('pointerdrag', () => { selectedIds = []; });
      map.on('moveend', () => {
        if (!enabled || !map.getTargetElement()?.getClientRects().length) return;
        currentMap = map;
        render();
      });
      return {
        // Called after small markers and storm cells so a regional polygon
        // never steals their taps. Return a boolean for radar.js's routing.
        handleClick(pixel) {
          if (!enabled || !layer.getVisible()) return false;
          const ids = new Set();
          map.forEachFeatureAtPixel(pixel, (feature) => { ids.add(feature.getId()); }, {
            layerFilter: (candidate) => candidate === layer, hitTolerance: 6,
          });
          if (!ids.size) return false;
          currentMap = map;
          selectedIds = [...ids];
          sheet.open();
          render();
          return true;
        },
      };
    },
    setTypes(types) {
      const nextTypes = new Set(types.filter((type) => WARNING_TYPES[type]));
      if ([...nextTypes].join(',') === [...enabledTypes].join(',')) return;
      enabledTypes = nextTypes;
      selectedIds = [];
      const value = enabledTypes.size > 0;
      if (enabled === value) { render(); return; }
      enabled = value;
      if (!enabled) {
        clearInterval(timer);
        request?.abort();
        request = null;
        selectedIds = [];
      } else {
        timer = setInterval(catchUp, 30000);
        if (!lastSuccess || Date.now() - lastSuccess >= REFRESH_MS || failed) refresh();
      }
      render();
    },
  };
}
