// EUMETSAT ENDPOINTS ARE WORKSPACE-LEVEL, NOT PER-LAYER, AND THAT IS A CORS
// FIX, NOT A TIDY-UP. view.eumetsat.int serves the same GeoServer under both
// /geoserver/<workspace>/<layer>/wms and /geoserver/<workspace>/wms, and on
// 2026-08-21 only the second one answered a GetMap with
// `Access-Control-Allow-Origin`. The per-layer path still sent the header on
// GetCapabilities — so the products kept appearing in the menus with a working
// timeline — but every image the browser fetched was blocked
// (`MissingAllowOriginHeader`), and the layers drew nothing at all. The app
// loads frames through fetch + blob: URLs (CLAUDE.md hard rule 5), so a missing
// header is fatal rather than merely inconvenient.
//
// Verified per product against both paths; the workspace path is also how
// meteocore is addressed here, so several entries now share one
// GetCapabilities document (seven fetches became two) and each names its own
// `layer` so wmsByLayerName can hand it the right title.

const wmsServerConfiguration = {
  eumetsat1: {
    url: 'https://view.eumetsat.int/geoserver/msg_fes/wms',
    layer: 'rgb_eview',
    refresh: 300000,
    category: 'satelliteLayer',
    title: 'Meteosat pilvialueet yö/päivä',
    abstract: 'Päivällä alapilvet näkyvät keltaisen sävyissä ja korkeat pilvet sinertävinä. Yöllä sinertävässä infrapunakuvassa kylmät pilvet näkyvät kirkaina.',
    attribution: 'EUMETSAT',
    disabled: false,
  },
  eumetsat2: {
    url: 'https://view.eumetsat.int/geoserver/msg_fes/wms',
    layer: 'rgb_convection',
    refresh: 300000,
    category: 'satelliteLayer',
    title: 'Meteosat konvektiopilvet',
    abstract: 'Vaaraa aiheuttavat konvektiiviset rajuilmat näkyvät kuvassa kirkkaan keltaisena. Ukkospilven alasimen läpäisevät huiput näkyvät kuvassa kirkkaan vaalean punaisena.',
    attribution: 'EUMETSAT',
    disabled: false,
  },
  eumetsat3: {
    url: 'https://view.eumetsat.int/geoserver/msg_fes/wms',
    layer: 'rgb_naturalenhncd',
    refresh: 300000,
    category: 'satelliteLayer',
    title: 'Meteosat pilvialueet',
    abstract: 'Vesipilvet näkyvät kuvassa vaaleina, jäiset valkoisina, kasvillisuus vihreänä, maa ruskeana ja meri mustana.',
    attribution: 'EUMETSAT',
    disabled: false,
  },
  'mtg-li-afa': {
    url: 'https://view.eumetsat.int/geoserver/mtg_fd/wms',
    layer: 'li_afa',
    refresh: 300000,
    category: 'lightningLayer',
    title: 'MTG salamakuvantaja',
    abstract: 'Meteosat Third Generation Lightning Imager – salamapurkaukset 5 minuutin tarkkuudella Euroopan ja Afrikan kattavalla geostationäärisellä alueella.',
    attribution: 'EUMETSAT',
    disabled: false,
  },
  'mtg-rgb-geocolour': {
    url: 'https://view.eumetsat.int/geoserver/mtg_fd/wms',
    layer: 'rgb_geocolour',
    refresh: 300000,
    category: 'satelliteLayer',
    title: 'MTG Geo Colour',
    abstract: 'Meteosat Third Generation Geo Colour RGB. Korkearesoluutioinen luonnonväreissä esitetty satelliittikuva, joka päivittyy 10 minuutin välein. Selkeä erottelu pilville, lumelle ja maanpinnalle.',
    attribution: 'EUMETSAT',
    disabled: false,
  },
  'msg-rdt': {
    url: 'https://view.eumetsat.int/geoserver/msg_fes/wms',
    layer: 'rdt',
    refresh: 300000,
    // Categorised as lightning even though the source is satellite — the
    // map's z-order puts satellite under the radar layer, so an RDT
    // satellite-category overlay was hidden whenever the radar mosaic
    // was visible. Lightning sits above radar; semantically it's also
    // closer (RDT marks convective cells, i.e. where lightning happens).
    category: 'lightningLayer',
    title: 'MSG Ukkossolut (RDT)',
    abstract: 'Meteosat Second Generation Rapidly Developing Thunderstorms. Konvektiivisten ukkossolujen tunnistus ja seuranta polygoneilla ja liikevektoreilla 15 minuutin välein.',
    attribution: 'EUMETSAT',
    format: 'image/png',
    transparent: true,
    disabled: false,
  },
  'msg-h60b': {
    url: 'https://view.eumetsat.int/geoserver/msg_fes/wms',
    layer: 'h60b',
    refresh: 300000,
    category: 'radarLayer',
    title: 'MSG sadeintensiteetti (H60B)',
    abstract: 'Blended SEVIRI / LEO MW -sadetuote. Geostationaarisen IR-kuvauksen ja matalan kiertoradan mikroaaltomittausten yhdistelmänä lasketut sadeintensiteettiarviot 15 minuutin välein. Käyttökelpoinen tutka-aineiston täydennys Suomen ulkopuolella.',
    attribution: 'EUMETSAT',
    format: 'image/png',
    transparent: true,
    disabled: false,
  },
  de: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'dwd-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'DWD',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  fi: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'fmi-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'FMI',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  // Nowcast mode: selecting this entry mixes the observed Finnish composite
  // (past half of the window) with this motion-extrapolated forecast product
  // (future half), see src/nowcast.js. Rides the same meteocore
  // GetCapabilities fetch as the other entries.
  'fi-nowcast': {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'fmi-radar-nowcast',
    refresh: 60000,
    category: 'radarLayer',
    title: 'Suomi + ennuste',
    abstract: 'Havaittu tutkakuva ja liikevektoreihin perustuva ennuste samalla aikajanalla: 30 minuuttia historiaa ja 30 minuuttia ennustetta 5 minuutin askelin.',
    attribution: 'FMI',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  eu: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'opera-reflectivity',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'EUMETNET OPERA',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  no: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'met-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'MET Norway',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  se: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'smhi-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'SMHI',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  dk: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'dmi-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'DMI',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  cz: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'chmi-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    attribution: 'CHMI',
    license: 'CC-BY-4.0',
    disabled: false,
  },
  pl: {
    url: 'https://meteocore.app.meteo.fi/wms',
    layer: 'imgw-radar-composite-dbz',
    refresh: 60000,
    category: 'radarLayer',
    // IMGW-PIB open data is licensed under the Polish public-data terms,
    // not CC-BY — attribution only, no license tag.
    attribution: 'IMGW-PIB',
    disabled: false,
  },
};

// Static layerInfo metadata for products that no longer come from any WMS
// GetCapabilities: the wms-obs GeoServer is permanently offline and these
// products are served by the MeteoCore EDR API, rendered client-side. Seeded
// into radar.js layerInfo at boot so the stored-product restore
// (restoreActiveLayer's category guard) and the playlist cards keep working.
// Deliberately WITHOUT `url` (updateLayer must not call setLayerUrl on the
// vector facades) and WITHOUT `time` (EDR layers adapt to any window and
// must not constrain the shared 13-frame math).
const FMI_ATTRIBUTION = { Title: 'FMI (CC-BY-4.0)' };
export const edrLayerInfo = {
  'observation:airtemperature': {
    category: 'observationLayer',
    layer: 'observation:airtemperature',
    title: 'Lämpötila',
    abstract: 'Lämpötila 2 metrin korkeudella (°C).',
    attribution: FMI_ATTRIBUTION,
  },
  'observation:dew_point_temperature': {
    category: 'observationLayer',
    layer: 'observation:dew_point_temperature',
    title: 'Kastepiste',
    abstract: 'Kastepistelämpötila (°C).',
    attribution: FMI_ATTRIBUTION,
  },
  'observation:relative_humidity': {
    category: 'observationLayer',
    layer: 'observation:relative_humidity',
    title: 'Kosteus',
    abstract: 'Suhteellinen kosteus (%).',
    attribution: FMI_ATTRIBUTION,
  },
  'observation:wind': {
    category: 'observationLayer',
    layer: 'observation:wind',
    title: 'Tuuli',
    abstract: 'Tuulen 10 minuutin keskinopeus (m/s) ja suunta.',
    attribution: FMI_ATTRIBUTION,
  },
  'observation:wind_speed': {
    category: 'observationLayer',
    layer: 'observation:wind_speed',
    title: 'Tuulen nopeus',
    abstract: 'Tuulen 10 minuutin keskinopeus (m/s).',
    attribution: FMI_ATTRIBUTION,
  },
  'observation:wind_speed_of_gust': {
    category: 'observationLayer',
    layer: 'observation:wind_speed_of_gust',
    title: 'Puuskat',
    abstract: 'Tuulen puuskanopeus (m/s).',
    attribution: FMI_ATTRIBUTION,
  },
  'observation:lightning': {
    category: 'lightningLayer',
    layer: 'observation:lightning',
    title: 'Salamahavainnot',
    abstract: 'Salamanpaikannusverkon havaitsemat maa- ja pilvisalamat.',
    attribution: FMI_ATTRIBUTION,
  },
};

export default wmsServerConfiguration;
