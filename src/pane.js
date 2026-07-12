// Pane factory — encapsulates everything that is per-map: the OpenLayers Map,
// its full layer stack (basemaps, 4 content layers, vector overlays), the
// per-pane GPS marker features, and the per-pane mutable selection state
// (VISIBLE / ACTIVE_LAYERS / LAYER_IN_RANGE).
//
// Split-screen renders N panes that all share ONE `ol/View` (passed in) so they
// pan/zoom in lockstep — the canonical OpenLayers "shared view" pattern. The
// global clock (in radar.js) drives every pane's FramePools off the same
// startDate. FramePools are NOT built here: radar.js owns them (it imports
// FramePool and wires the timeline-aggregation callbacks) and attaches them to
// `pane.framePools` via buildPanePools().
//
// pane 0 is the original single map; its VISIBLE/ACTIVE_LAYERS/LAYER_IN_RANGE
// objects are the same instances radar.js aliases as its module globals, so the
// existing single-map code path is byte-for-byte unchanged in 1-up.

import { Map } from 'ol';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import VectorTileLayer from 'ol/layer/VectorTile';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import VectorTileSource from 'ol/source/VectorTile';
import GeoJSON from 'ol/format/GeoJSON';
import MVT from 'ol/format/MVT';
import Vector from 'ol/source/Vector';
import Feature from 'ol/Feature';
import { Fill, Style } from 'ol/style';
import { gpsPositionStyle } from './ais/ownShipStyle';
import { track } from './analytics';
import { createGetMapSizeGuard } from './wms/requestShape';
import airfieldsUrl from './data/airfields-finland.geojson';

// The own-position marker + grey accuracy disc. One pair per pane so the
// marker can render in every pane; the ownLocation controller updates each
// pane's geometry (and swaps the style when the AIS source is active).
function makePositionFeatures() {
  const positionFeature = new Feature();
  positionFeature.setStyle(gpsPositionStyle);

  const accuracyFeature = new Feature();
  accuracyFeature.setStyle(new Style({
    fill: new Fill({ color: [128, 128, 128, 0.3] }),
  }));

  return { positionFeature, accuracyFeature };
}

// Build one pane. `deps` carries the shared singletons the layers reference:
//   options          — wmsServerConfiguration, imageRatio, default layer names
//   radarSiteSource  — shared VectorSource feeding every pane's radarSiteLayer
//   radarStyle, icaoStyle, municipalityStyleLight, vesivaylatStyleFn,
//   vesivaylaAreaStyle, rangeStyle — shared Style objects / style functions
//   visible          — Set seed for this pane's VISIBLE (used as-is, not cloned)
//   activeLayers     — object seed for this pane's ACTIVE_LAYERS (used as-is)
export default function createPane(targetEl, sharedView, deps) {
  const {
    options,
    radarSiteSource,
    radarStyle,
    icaoStyle,
    municipalityStyleLight,
    vesivaylatStyleFn,
    vesivaylaAreaStyle,
    rangeStyle,
    // Layer factories for the EDR-backed vector layers (observations, FMI
    // lightning). radar.js owns the controllers; panes just host the layers.
    createObservationLayer,
    createLightningLayer,
    // Place-name labels (src/placeNames.js) — panes share one VectorSource.
    createPlaceNamesLayer,
    visible,
    activeLayers,
    layerInRange = {},
    // For pane 0 the caller passes its existing module-global framePools object
    // so radar.js's `framePools` const and `pane0.framePools` are one and the
    // same; new panes get a fresh holder. buildPanePools() fills it later.
    framePools = {
      satelliteLayer: null,
      radarLayer: null,
      lightningWmsLayer: null,
    },
    index = 0,
  } = deps;

  const VISIBLE = visible;
  const ACTIVE_LAYERS = activeLayers;
  const LAYER_IN_RANGE = layerInRange;

  //
  // BASEMAPS
  //
  // Every raster source below requests images with CORS (crossOrigin:
  // 'anonymous') so the layer canvases stay untainted and the share tool can
  // export the map with canvas.toBlob(). One non-CORS draw taints a canvas
  // permanently. All the servers return Access-Control-Allow-Origin: *.
  const lightGrayBaseLayer = new TileLayer({
    visible: false,
    preload: Infinity,
    source: new XYZ({
      attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer">ArcGIS</a>',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      crossOrigin: 'anonymous',
    }),
  });

  const darkGrayBaseLayer = new TileLayer({
    preload: Infinity,
    source: new XYZ({
      attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer">ArcGIS</a>',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      crossOrigin: 'anonymous',
    }),
  });

  // Place-name labels replace the ArcGIS reference (label) tile layers: one
  // theme-agnostic vector layer whose style setMapLayer swaps, instead of two
  // rasters toggled per theme. Sits above the animated rasters but below the
  // lightning/observation vectors and every tool overlay.
  const placeNamesLayer = createPlaceNamesLayer();

  //
  // CONTENT LAYERS
  //
  // Drop-and-report guard for runaway base-source GetMaps (WIDTH/HEIGHT in
  // the tens of thousands — see requestShape.js MAX_GETMAP_DIM). The
  // telemetry captures the container/window geometry at the moment of the
  // oversize render so the layout transient causing it can be identified.
  const getMapGuard = (layerName) => createGetMapSizeGuard((w, h) => {
    console.warn(`Dropped oversize GetMap ${w}x${h} (${layerName}, pane ${index})`); // eslint-disable-line no-console
    track('oversize-getmap', {
      layer: layerName,
      size: `${w}x${h}`,
      el: `${targetEl.clientWidth}x${targetEl.clientHeight}`,
      win: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      pane: index,
    });
  });

  const satelliteLayer = new ImageLayer({
    name: 'satelliteLayer',
    visible: VISIBLE.has('satelliteLayer'),
    opacity: 0.7,
    source: new ImageWMS({
      url: options.wmsServerConfiguration.eumetsat1.url,
      params: { FORMAT: 'image/jpeg', LAYERS: 'rgb_eview' },
      hidpi: false,
      attributions: 'EUMETSAT',
      ratio: options.imageRatio,
      serverType: 'geoserver',
      crossOrigin: 'anonymous',
      imageLoadFunction: getMapGuard('satelliteLayer'),
    }),
  });
  satelliteLayer.set('defaultFormat', 'image/jpeg');
  satelliteLayer.set('defaultTransparent', false);

  const radarLayer = new ImageLayer({
    name: 'radarLayer',
    visible: VISIBLE.has('radarLayer'),
    opacity: 0.7,
    source: new ImageWMS({
      url: options.wmsServerConfiguration.fi.url,
      params: { LAYERS: options.defaultRadarLayer },
      attributions: 'FMI (CC-BY-4.0)',
      ratio: options.imageRatio,
      hidpi: false,
      serverType: 'geoserver',
      // Lets the center-crosshair tool read the rendered radar pixel colour off
      // the canvas (getData) without tainting it. The meteocore WMS returns
      // Access-Control-Allow-Origin: *, so it's safe.
      crossOrigin: 'anonymous',
      imageLoadFunction: getMapGuard('radarLayer'),
    }),
  });
  radarLayer.set('defaultFormat', 'image/png');
  // Opt out of the webp wire format for radar specifically (see radar.js notes).
  radarLayer.set('disableWebp', true);

  // FMI lightning is an EDR-backed vector layer (src/lightning/); this
  // companion raster carries the category's WMS products (li_afa/rdt from
  // view.eumetsat.int). Hidden until a WMS product is selected — the
  // lightning controller owns its visibility; radar.js owns its FramePool.
  const lightningLayer = createLightningLayer(index, VISIBLE.has('lightningLayer'));
  const lightningWmsLayer = new ImageLayer({
    name: 'lightningWmsLayer',
    visible: false,
    source: new ImageWMS({
      url: options.wmsServerConfiguration['mtg-li-afa'].url,
      params: { FORMAT: 'image/png', TRANSPARENT: 'TRUE', LAYERS: 'li_afa' },
      ratio: options.imageRatio,
      hidpi: false,
      serverType: 'geoserver',
      crossOrigin: 'anonymous',
      imageLoadFunction: getMapGuard('lightningWmsLayer'),
    }),
  });
  lightningWmsLayer.set('defaultFormat', 'image/png');
  lightningWmsLayer.set('_paneIndex', index);

  // Observations are an EDR-backed vector layer too (src/obs/); the wms-obs
  // GeoServer that once rendered both as rasters is permanently offline.
  const observationLayer = createObservationLayer(index, VISIBLE.has('observationLayer'));

  // Back-reference so radar.js can resolve which pane owns a layer when a
  // layer-level event (change:visible / propertychange) fires.
  satelliteLayer.set('_paneIndex', index);
  radarLayer.set('_paneIndex', index);
  lightningLayer.set('_paneIndex', index);
  observationLayer.set('_paneIndex', index);

  //
  // VECTOR OVERLAYS
  //
  const radarSiteLayer = new VectorLayer({
    source: radarSiteSource,
    style(feature) {
      radarStyle.getText().setText(feature.get('name'));
      return radarStyle;
    },
  });

  const icaoLayer = new VectorLayer({
    source: new Vector({
      format: new GeoJSON(),
      url: airfieldsUrl,
    }),
    visible: false,
    style(feature) {
      icaoStyle.getText().setText(feature.get('icao'));
      return icaoStyle;
    },
  });

  const municipalityLayer = new VectorTileLayer({
    visible: false,
    renderMode: 'vector',
    source: new VectorTileSource({
      format: new MVT(),
      url: 'https://meteocore.app.meteo.fi/tiles/collections/fi-municipalities/tiles/WebMercatorQuad/{z}/{y}/{x}?f=mvt',
      attributions: 'Statistics Finland / Tilastokeskus',
      maxZoom: 14,
    }),
    style: municipalityStyleLight,
  });

  const vesivaylaAreaLayer = new VectorLayer({
    visible: false,
    source: new Vector({
      format: new GeoJSON(),
      url: 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections/vesivaylatiedot:vaylaalueet_uusi/items?f=application/geo%2Bjson&limit=10000',
      attributions: 'Väylävirasto',
    }),
    style: vesivaylaAreaStyle,
  });

  const vesivaylatLayer = new VectorLayer({
    visible: false,
    declutter: true,
    source: new Vector({
      format: new GeoJSON(),
      url: 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections/vesivaylatiedot:vaylat_uusi/items?f=application/geo%2Bjson&limit=10000',
      attributions: 'Väylävirasto',
    }),
    style: vesivaylatStyleFn,
  });

  const guideLayer = new VectorLayer({
    source: new Vector(),
    style: rangeStyle,
  });

  const { positionFeature, accuracyFeature } = makePositionFeatures();
  const ownPositionLayer = new VectorLayer({
    visible: false,
    // Re-render during zoom/pan so the AIS symbol's pixel-sized geometries
    // (triangle, heading line — computed from the frame's resolution) stay a
    // constant screen size instead of scaling with the map and snapping back
    // when the gesture ends. One feature pair; per-frame restyle is cheap.
    updateWhileAnimating: true,
    updateWhileInteracting: true,
    source: new Vector({
      features: [accuracyFeature, positionFeature],
    }),
  });

  const layerss = {
    satelliteLayer,
    radarLayer,
    observationLayer,
    lightningLayer,
  };

  const layers = [
    lightGrayBaseLayer,
    darkGrayBaseLayer,
    satelliteLayer,
    radarLayer,
    placeNamesLayer,
    guideLayer,
    lightningWmsLayer,
    lightningLayer,
    municipalityLayer,
    vesivaylaAreaLayer,
    vesivaylatLayer,
    radarSiteLayer,
    icaoLayer,
    ownPositionLayer,
    observationLayer,
  ];

  const map = new Map({
    target: targetEl,
    layers,
    controls: [],
    view: sharedView,
    keyboardEventTarget: document,
  });

  return {
    index,
    el: targetEl,
    map,
    view: sharedView,
    layers,
    layerss,
    // individual layer handles
    lightGrayBaseLayer,
    darkGrayBaseLayer,
    placeNamesLayer,
    satelliteLayer,
    radarLayer,
    lightningLayer,
    lightningWmsLayer,
    observationLayer,
    radarSiteLayer,
    icaoLayer,
    municipalityLayer,
    vesivaylaAreaLayer,
    vesivaylatLayer,
    guideLayer,
    ownPositionLayer,
    positionFeature,
    accuracyFeature,
    // per-pane mutable state
    VISIBLE,
    ACTIVE_LAYERS,
    LAYER_IN_RANGE,
    // FramePools are attached later by radar.js buildPanePools()
    framePools,
    updateSize() { map.updateSize(); },
  };
}
