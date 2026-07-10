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
import {
  Circle as CircleStyle, Fill, Stroke, Style,
} from 'ol/style';

// The blue GPS dot + grey accuracy disc. One pair per pane so the marker can
// render in every pane; radar.js updates each pane's geometry on GPS change.
function makePositionFeatures() {
  const positionFeature = new Feature();
  positionFeature.setStyle(new Style({
    image: new CircleStyle({
      radius: 6,
      fill: new Fill({ color: '#3399CC' }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
  }));

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
    visible,
    activeLayers,
    layerInRange = {},
    // For pane 0 the caller passes its existing module-global framePools object
    // so radar.js's `framePools` const and `pane0.framePools` are one and the
    // same; new panes get a fresh holder. buildPanePools() fills it later.
    framePools = {
      satelliteLayer: null,
      radarLayer: null,
      lightningLayer: null,
      observationLayer: null,
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

  const lightGrayReferenceLayer = new TileLayer({
    visible: false,
    source: new XYZ({
      attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer">ArcGIS</a>',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
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

  const darkGrayReferenceLayer = new TileLayer({
    source: new XYZ({
      attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer">ArcGIS</a>',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      crossOrigin: 'anonymous',
    }),
  });

  //
  // CONTENT LAYERS
  //
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
    }),
  });
  radarLayer.set('defaultFormat', 'image/png');
  // Opt out of the webp wire format for radar specifically (see radar.js notes).
  radarLayer.set('disableWebp', true);

  const lightningLayer = new ImageLayer({
    name: 'lightningLayer',
    visible: VISIBLE.has('lightningLayer'),
    source: new ImageWMS({
      url: options.wmsServerConfiguration['meteo-obs-new'].url,
      params: { FORMAT: 'image/png8', LAYERS: options.defaultLightningLayer },
      ratio: options.imageRatio,
      hidpi: false,
      serverType: 'geoserver',
      crossOrigin: 'anonymous',
    }),
  });
  lightningLayer.set('defaultFormat', 'image/png8');

  const observationLayer = new ImageLayer({
    name: 'observationLayer',
    visible: VISIBLE.has('observationLayer'),
    source: new ImageWMS({
      url: options.wmsServerConfiguration['meteo-obs-new'].url,
      params: { FORMAT: 'image/png8', LAYERS: options.defaultObservationLayer },
      ratio: options.imageRatio,
      hidpi: false,
      serverType: 'geoserver',
      crossOrigin: 'anonymous',
    }),
  });
  observationLayer.set('defaultFormat', 'image/png8');

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
      url: 'airfields-finland.json',
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
    guideLayer,
    lightningLayer,
    lightGrayReferenceLayer,
    darkGrayReferenceLayer,
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
    lightGrayReferenceLayer,
    darkGrayBaseLayer,
    darkGrayReferenceLayer,
    satelliteLayer,
    radarLayer,
    lightningLayer,
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
