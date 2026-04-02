import {Map, View} from 'ol';
import {MousePosition} from 'ol/control.js';
import Geolocation from 'ol/Geolocation';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import TileWMS from 'ol/source/TileWMS';
import GeoJSON from 'ol/format/GeoJSON';
import Vector from 'ol/source/Vector';
import {fromLonLat, transform} from 'ol/proj';
import sync from 'ol-hashed';
import Feature from 'ol/Feature';
import {circular} from 'ol/geom/Polygon';
import {getDistance} from 'ol/sphere.js';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import {Circle as CircleStyle, Fill, Stroke, Style, Text} from 'ol/style.js';
import Dms from 'geodesy/dms';
import LatLon from 'geodesy/latlon-spherical'
import WMSCapabilities from 'ol/format/WMSCapabilities.js';
import { transformExtent } from 'ol/proj';
import Timeline from './timeline';
import 'dayjs/locale/fi';
import {VERSION as OL_VERSION} from 'ol/util';


var options = {
	defaultRadarLayer: 'suomi_dbz_eureffin',
	defaultLightningLayer: 'observation:lightning',
	defaultObservationLayer: 'observation:airtemperature',
	rangeRingSpacing: 50,
	radialSpacing: 30,
	frameRate: 2, // fps
	defaultFrameRate: 2, // fps
	imageRatio: 1.5,
	wmsServerConfiguration: {
		'fmi-radar': {
			url: 'https://openwms.fmi.fi/geoserver/Radar/wms',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'FMI (CC-BY-4.0)',
			disabled: false
		},
		'meteo-radar': {
			url: 'https://wms.meteo.fi/geoserver/wms',
			namespace: 'radar',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'FMI (CC-BY-4.0)',
			disabled: false
		},
		'meteo-obs-new': {
			url: 'https://wms-obs.app.meteo.fi/geoserver/wms',
			namespace: 'observation',
			refresh: 300000,
			category: 'observationLayer',
			attribution: 'FMI (CC-BY-4.0)'
		},
		'meteo-obs': {
			url: 'https://geoserver.app.meteo.fi/geoserver/wms',
			namespace: 'observation',
			refresh: 300000,
			category: 'observationLayer',
			attribution: 'FMI (CC-BY-4.0)',
			disabled: true
		},
		'eumetsat': {
			url: 'https://eumetview.eumetsat.int/geoserv/wms',
			namespace: 'meteosat',
			refresh: 300000,
			category: "satelliteLayer",
			attribution: 'EUMETSAT',
			disabled: true
		},
		'eumetsat1': {
			url: 'https://view.eumetsat.int/geoserver/msg_fes/rgb_eview/wms',
			refresh: 300000,
			category: "satelliteLayer",
			title: 'Meteosat pilvialueet yö/päivä',
			abstract: 'Päivällä alapilvet näkyvät keltaisen sävyissä ja korkeat pilvet sinertävinä. Yöllä sinertävässä infrapunakuvassa kylmät pilvet näkyvät kirkaina.',
			attribution: 'EUMETSAT',
			disabled: false
		},
		'eumetsat2': {
			url: 'https://view.eumetsat.int/geoserver/msg_fes/rgb_convection/wms',
			refresh: 300000,
			category: "satelliteLayer",
			title: 'Meteosat konvektiopilvet',
			abstract: 'Vaaraa aiheuttavat konvektiiviset rajuilmat näkyvät kuvassa kirkkaan keltaisena. Ukkospilven alasimen läpäisevät huiput näkyvät kuvassa kirkkaan vaalean punaisena.',
			attribution: 'EUMETSAT',
			disabled: false
		},
		'eumetsat3': {
			url: 'https://view.eumetsat.int/geoserver/msg_fes/rgb_naturalenhncd/wms',
			refresh: 300000,
			category: "satelliteLayer",
			title: 'Meteosat pilvialueet',
			abstract: 'Vesipilvet näkyvät kuvassa vaaleina, jäiset valkoisina, kasvillisuus vihreänä, maa ruskeana ja meri mustana.',
			attribution: 'EUMETSAT',
			disabled: false
		},
		'eumetsat4': {
			url: 'https://eumetview.eumetsat.int/geoserv/meteosat/msg_airmass/wms',
			refresh: 300000,
			category: "satelliteLayer",
			title: 'Meteosat ilmamassat',
			abstract: 'Kylmä polaarinen ilma näkyy kuvassa violettina, lämmin trooppinen ilma vihreänä, kuiva ilma punaisena sekä paksut korkeat pilvet valkoisena.',
			attribution: 'EUMETSAT',
			disabled: true
		},
		ca: {
			url: 'https://geo.weather.gc.ca/geomet/',
			layer: 'RADAR_1KM_RRAI',
			refresh: 300000,
			category: 'radarLayer',
			disabled: false
		},
		de: {
			url: 'https://maps.dwd.de/geoserver/dwd/RX-Produkt/wms',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'Deutscher Wetterdienst',
			disabled: true
		},
		nl: {
			url: 'https://geoservices.knmi.nl/cgi-bin/RADNL_OPER_R___25PCPRR_L3.cgi',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'KNMI',
			disabled: true
		},
		no: {
			url: 'https://meteocore.app.meteo.fi/wms',
			layer: 'met-radar-composite-dbz',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'MET Norway',
			disabled: false
		},
		se: {
			url: 'https://meteocore.app.meteo.fi/wms',
			layer: 'smhi-radar-composite-dbz',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'SMHI',
			disabled: false
		},
		dk: {
			url: 'https://meteocore.app.meteo.fi/wms',
			layer: 'dmi-radar-composite-dbz',
			refresh: 60000,
			category: 'radarLayer',
			attribution: 'DMI',
			disabled: false
		},
		vn: {
			url: 'https://vietnam.smartmet.fi/wms',
			namespace: 'vnmha:radar',
			refresh: 60000,
			category: "radarLayer",
			attribution: 'VNMHA',
			disabled: true
		},
		noaa: {
			url: 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi',
			refresh: 60000,
			category: "radarLayer",
			attribution: 'NOAA',
			disabled: true
		}
	}
}

let DEBUG = false;
var metLatitude = localStorage.getItem("metLatitude")
	? localStorage.getItem("metLatitude")
	: 60.2706;
var metLongitude = localStorage.getItem("metLongitude")
	? localStorage.getItem("metLongitude") 
	: 24.8725;
var metPosition = (() => { try { return JSON.parse(localStorage.getItem("metPosition")) || []; } catch (e) { return []; } })();
var metZoom = localStorage.getItem("metZoom") || 9;
var ownPosition = [];
var ownPosition4326 = [];
var geolocation;
var startDate = new Date(Math.floor(Date.now() / 300000) * 300000 - 300000 * 12);
var animationId = null;
var dayjs = require('dayjs');
dayjs.locale('fi');
var utcplugin = require('dayjs/plugin/utc');
dayjs.extend(utcplugin);
var localizedFormat = require('dayjs/plugin/localizedFormat');
dayjs.extend(localizedFormat);
var duration = require('dayjs/plugin/duration');
dayjs.extend(duration);
var layerInfo = {};
var timeline;
var mapTime = "";

// STATUS Variables
function safeParseJSON(key, fallback) {
	try { var v = JSON.parse(localStorage.getItem(key)); return v != null ? v : fallback; }
	catch (e) { return fallback; }
}

var VISIBLE = new Set(safeParseJSON("VISIBLE", ["radarLayer"]));

var ACTIVE = new Set(safeParseJSON("ACTIVE", [options.defaultRadarLayer]));

var IS_DARK = safeParseJSON("IS_DARK", true);

var IS_TRACKING = safeParseJSON("IS_TRACKING", false);

var IS_FOLLOWING = safeParseJSON("IS_FOLLOWING", false);

var IS_NAUTICAL = safeParseJSON("IS_NAUTICAL", false);

function debug(str) {
	if (DEBUG) {
		try {
			console.log(str);
		} catch (e) { };
	}
}

ImageLayer.prototype.setLayerUrl = function (url) {
	debug("Set layer url: " + url);
	this.getSource().setUrl(url);
}

ImageLayer.prototype.setLayerStyle = function (style) {
	debug("Set layer style: " + style);
	this.getSource().updateParams({ 'STYLES': style });
}

ImageLayer.prototype.setLayerTime = function (time) {
	let timemoment = dayjs(time);
	debug("Set layer time dimension: " + timemoment.format());
	if (timemoment.isValid()) {
		this.getSource().updateParams({ 'TIME': timemoment.format()});
	}
}

ImageLayer.prototype.setLayerElevation = function (elevation) {
	debug("Set layer elevation dimension: " + elevation);
	this.getSource().updateParams({ 'ELEVATION': elevation });
}

// STYLES
var style = new Style({
	fill: new Fill({
		color: 'rgba(255, 255, 255, 0.6)'
	}),
	stroke: new Stroke({
		color: '#D32D25',
		width: 1
	}),
	text: new Text({
		font: '16px Calibri,sans-serif',
		fill: new Fill({
			color: '#fff'
		}),
		stroke: new Stroke({
			color: '#000',
			width: 2
		}),
		offsetX: 0,
		offsetY: -20
	})
});

var radarStyle = new Style({
	image: new CircleStyle({
		radius: 4,
		fill: null,
		stroke: new Stroke({ color: 'red', width: 2 })
	}),
	text: new Text({
		font: '12px Calibri,sans-serif',
		fill: new Fill({
			color: '#fff'
		}),
		stroke: new Stroke({
			color: '#000',
			width: 3
		}),
		offsetX: 0,
		offsetY: -15
	})
});

var icaoStyle = new Style({
	image: new CircleStyle({
		radius: 4,
		fill: null,
		stroke: new Stroke({ color: 'blue', width: 2 })
	}),
	text: new Text({
		font: '12px Calibri,sans-serif',
		fill: new Fill({
			color: '#fff'
		}),
		stroke: new Stroke({
			color: '#000',
			width: 3
		}),
		offsetX: 0,
		offsetY: -15
	})
});

var ownStyle = new Style({
	image: new CircleStyle({
		radius: 5,
		fill: null,
		stroke: new Stroke({ color: 'red', width: 2 })
	}),
	fill: null,
	stroke: new Stroke({ color: 'red', width: 2 }),
	text: new Text({
		font: '10px Calibri,sans-serif',
		fill: new Fill({
			color: '#fff'
		}),
		stroke: new Stroke({
			color: '#000',
			width: 2
		}),
		offsetX: 0,
		offsetY: -20
	})
});

var rangeStyle = new Style({
	stroke: new Stroke({
		color: [128,128,128,0.7],
		width: 0.5
	}),
	text: new Text({
		font: '16px Calibri,sans-serif',
		fill: new Fill({
			color: '#fff'
		}),
		stroke: new Stroke({
			color: '#000',
			width: 2
		}),
		offsetX: 0,
		offsetY: 0,
		textAlign: 'left',
	})
});

//
// FEATURES
// 
var positionFeature = new Feature();
positionFeature.setStyle(new Style({
	image: new CircleStyle({
		radius: 6,
		fill: new Fill({
			color: '#3399CC'
		}),
		stroke: new Stroke({
			color: '#fff',
			width: 2
		})
	})
}));

var accuracyFeature = new Feature();
accuracyFeature.setStyle(new Style({
	fill: new Fill({
		color: [128,128,128,0.3]
	}),
}));

//
// LAYERS
//
var imageryBaseLayer = new TileLayer({
	visible: false,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/World_Imagery/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'World_Imagery/MapServer/tile/{z}/{y}/{x}'
	})
});

var lightGrayBaseLayer = new TileLayer({
	visible: false,
	preload: Infinity,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Light_Gray_Base/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
	})
});

var lightGrayReferenceLayer = new TileLayer({
	visible: false,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Light_Gray_Reference/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
	})
});

var darkGrayBaseLayer = new TileLayer({
	preload: Infinity,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Dark_Gray_Base/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
	})
});

var darkGrayReferenceLayer = new TileLayer({
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Dark_Gray_Reference/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
	})
});

// Satellite Layer
var satelliteLayer = new ImageLayer({
	name: "satelliteLayer",
	visible: VISIBLE.has("satelliteLayer"),
	opacity: 0.7,
	source: new ImageWMS({
		url: options.wmsServerConfiguration.eumetsat1.url,
		params: { 'FORMAT': 'image/jpeg', 'LAYERS': "rgb_eview" },
		hidpi: false,
		attributions: 'EUMETSAT',
		ratio: options.imageRatio,
		serverType: 'geoserver'
	})
});

// Radar Layer
var radarLayer = new ImageLayer({
	name: "radarLayer",
	visible: VISIBLE.has("radarLayer"),
	opacity: 0.7,
	source: new ImageWMS({
		url: options.wmsServerConfiguration["fmi-radar"].url,
		params: { 'LAYERS': options.defaultRadarLayer },
		attributions: 'FMI (CC-BY-4.0)',
		ratio: options.imageRatio,
		hidpi: false,
		serverType: 'geoserver'
	})
});

// Lightning Layer
var lightningLayer = new ImageLayer({
	name: "lightningLayer",
	visible: VISIBLE.has("lightningLayer"),
	source: new ImageWMS({
		url: options.wmsServerConfiguration["meteo-obs-new"].url,
		params: { 'FORMAT': 'image/png8', 'LAYERS': options.defaultLightningLayer },
		ratio: options.imageRatio,
		hidpi: false,
		serverType: 'geoserver'
	})
});

// Observation Layer
var observationLayer = new ImageLayer({
	name: "observationLayer",
	visible: VISIBLE.has("observationLayer"),
	source: new ImageWMS({
		url: options.wmsServerConfiguration["meteo-obs-new"].url,
		params: { 'FORMAT': 'image/png8', 'LAYERS': options.defaultObservationLayer },
		ratio: options.imageRatio,
		hidpi: false,
		serverType: 'geoserver'
	})
});


var radarSiteLayer = new VectorLayer({
	source: new Vector({
		format: new GeoJSON(),
		url: 'radars-finland.json',
	}),
	style: function(feature) {
		radarStyle.getText().setText(feature.get('name'));
    return radarStyle;
  }
});

var icaoLayer = new VectorLayer({
	source: new Vector({
		format: new GeoJSON(),
		url: 'airfields-finland.json'
	}),
	visible: true,
	style: function(feature) {
		icaoStyle.getText().setText(feature.get('icao'));
		return icaoStyle;
	}
});

var guideLayer = new VectorLayer({
	source: new Vector(),
	style: rangeStyle,
/* 	style: function(feature) {
		rangeStyle.getText().setText(feature.get('name'));
    return rangeStyle;
  } */
});

var ownPositionLayer = new VectorLayer({
	visible: false,
	source: new Vector({
		features: [accuracyFeature, positionFeature]
	})
});


var layerss = {
	"satelliteLayer": satelliteLayer,
	"radarLayer": radarLayer,
	"observationLayer": observationLayer,
	"lightningLayer": lightningLayer
}

var layers = [
	lightGrayBaseLayer,
	darkGrayBaseLayer,
	imageryBaseLayer,
	//s57Layer,
	satelliteLayer,
	radarLayer,
	guideLayer,
	lightningLayer,
	lightGrayReferenceLayer,
	darkGrayReferenceLayer,
	radarSiteLayer,
	icaoLayer,
	ownPositionLayer,
	observationLayer
];

function distanceToString(distance) {
	let str;
	if (IS_NAUTICAL) {
		str = `${(distance / 1852).toFixed(3)} NM`;
	} else {
		str = distance < 1000 
			? `${Math.round(distance)} m` 
			: `${(distance / 1000).toFixed(1)} km`;
	}
	return str;
}

function mouseCoordinateFormat(coordinate) {
	if (ownPosition4326.length > 1) {
		var distance = getDistance(coordinate, ownPosition4326);
		var p1 = new LatLon(ownPosition4326[1], ownPosition4326[0]);
		var p2 = new LatLon(coordinate[1], coordinate[0]);
		var bearing = p1.initialBearingTo(p2);
		document.getElementById("cursorDistanceValue").innerHTML = distanceToString(distance) + '<br>' + bearing.toFixed(0) + "&deg;";
	}
	return Dms.toLat(coordinate[1], "dm", 3) + " " + Dms.toLon(coordinate[0], "dm", 3);
}

var mousePositionControl = new MousePosition({
	coordinateFormat: mouseCoordinateFormat,
	projection: 'EPSG:4326',
	className: 'custom-mouse-position',
	target: document.getElementById('cursorTxt'),
	undefinedHTML: 'Cursor not on map'
});

const map = new Map({
  target: 'map',
	layers: layers,
	controls: [
		mousePositionControl
	],
  view: new View({
		enableRotation: false,
		center: fromLonLat([26, 65]),
		maxZoom: 16,
    zoom: 5
	}),
	keyboardEventTarget: document
});


function rangeRings(layer, coordinates, range) {
	if (typeof range === 'number' && layer && coordinates) {
		const ring = circular(coordinates, range);
		const transformedRing = ring.transform('EPSG:4326', map.getView().getProjection());
		const feature = new Feature({
			name: `${range / 1000} km`,
			geometry: transformedRing
		});

		layer.getSource().addFeatures([feature]);
	}
}

function bearingLine(layer, coordinates, range, direction) {
	var c = new LatLon(coordinates[1], coordinates[0]);
	var p1 = c.destinationPoint(50000, direction);
	var p2 = c.destinationPoint(range * 1000, direction);
	var line = new Polygon([[[p1.lon, p1.lat], [p2.lon, p2.lat]]]);
	layer.getSource().addFeatures([
		new Feature({name: direction + 'dasd', geometry: line.transform('EPSG:4326', map.getView().getProjection())})
	]);
}

// GEOLOCATION Functions

function onChangeAccuracyGeometry(event) {
	debug('Accuracy geometry changed.');
	accuracyFeature.setGeometry(event.target.getAccuracyGeometry());
}

function onChangeSpeed(event) {
	debug('Speed changed.');
	let speed = event.target.getSpeed();
	if (Number.isFinite(speed)) {
		document.getElementById("currentSpeed").style.display = 'block';
		document.getElementById("currentSpeedValue").innerHTML = Math.round(speed * 3600 / 1000);
	} else {
		document.getElementById("currentSpeed").style.display = 'none';
	}
}

function onChangePosition(event) {
	debug('Position changed.');
	var coordinates = event.target.getPosition();
	ownPosition = coordinates;
	ownPosition4326 = transform(coordinates,map.getView().getProjection(),'EPSG:4326');
	positionFeature.setGeometry(coordinates ?
		new Point(coordinates) : null);
	document.getElementById("gpsStatus").innerHTML = "gps_fixed";
	document.getElementById("positionLatValue").innerHTML = "&#966; " + Dms.toLat(ownPosition4326[1], "dm", 3);
	document.getElementById("positionLonValue").innerHTML = "&#955; " + Dms.toLon(ownPosition4326[0], "dm", 3);
	document.getElementById("cursorDistanceTxt").style.display = "block";
	localStorage.setItem("metLatitude",ownPosition4326[1]);
	localStorage.setItem("metLongitude",ownPosition4326[0]);
	localStorage.setItem("metPosition",JSON.stringify(ownPosition));
//	if (IS_TRACKING) {
//		map.getView().setCenter(ownPosition);
//	}
};

// WMS 
const currentMapTimeDiv = document.getElementById("currentMapTime");
const currentMapDateDiv = document.getElementById("currentMapDate");
function setLayerTime(layer, time) {
  const t = dayjs(time);
  layer.getSource().updateParams({ TIME: time });
  if (t.isValid() && mapTime !== time) {
    const datestr = t.format("l");
    const timestr = t.format("LT");
    currentMapDateDiv.textContent = datestr;
		currentMapTimeDiv.textContent = timestr;
		mapTime=time;
  }
}

//radarLayer.getSource().addEventListener('imageloadend', function (event) {
//	debug(event);
//});

function getActiveLayers() {
	let layers = [];
	if (satelliteLayer.getVisible()) {
		layers.push(satelliteLayer.getSource().getParams().LAYERS);
	}
	if (radarLayer.getVisible()) {
		layers.push(radarLayer.getSource().getParams().LAYERS);
	}
	if (lightningLayer.getVisible()) {
		layers.push(lightningLayer.getSource().getParams().LAYERS);
	}
	if (observationLayer.getVisible()) {
		layers.push(observationLayer.getSource().getParams().LAYERS);
	}
	return layers;
}

function updateCanonicalPage() {
	let page = "";
	let title = "Meteo.FI ";
	if (satelliteLayer.getVisible()) {
		let split = satelliteLayer.getSource().getParams().LAYERS.split(":");
		page = page + "/" + ((split.length > 1) ? split[1] : split[0]);
		title = title + ' / ' + "Sääsatelliitti";
	}
	if (radarLayer.getVisible()) {
		let split = radarLayer.getSource().getParams().LAYERS.split(":");
		page = page + "/" + ((split.length > 1) ? split[1] : split[0]);
		title = title + ' / ' + 'Säätutka';
	}
	if (lightningLayer.getVisible()) {
		let split = lightningLayer.getSource().getParams().LAYERS.split(":");
		page = page + "/" + ((split.length > 1) ? split[1] : split[0])
	}
	if (observationLayer.getVisible()) {
		let split = observationLayer.getSource().getParams().LAYERS.split(":");
		page = page + "/" + ((split.length > 1) ? split[1] : split[0])
	}
	debug("Set page: " + page);
	//debug("Set title: " + title);
	//document.title = title;
	//gtag('config', 'UA-23910741-3', { 'page_path': page });
}

function setTime(action='next') {
	var resolution = 300000;
	var end = Math.floor(Date.now() / resolution) * resolution - resolution;
  var start = end - resolution * 12;

	
	for (let item of VISIBLE) {
		var wmslayer = layerss[item].getSource().getParams().LAYERS;
		if (wmslayer in layerInfo) {
			if (item == "radarLayer" || item == "satelliteLayer" || item == "observationLayer") {
				end = Math.min(end, Math.floor(layerInfo[wmslayer].time.end / resolution) * resolution);
			}
			resolution = Math.max(resolution, layerInfo[wmslayer].time.resolution);
		}
	}

		end = Math.floor(end / resolution) * resolution ;
		start = Math.floor(end / resolution) * resolution - resolution * 12;
		

	switch (action) {
		case 'first':
			startDate = new Date(start);
			break;
		case 'last':
			startDate = new Date(end);
			break;
		case 'previous':
			startDate.setMinutes(Math.floor(startDate.getMinutes() / (resolution / 60000)) * (resolution / 60000) - resolution / 60000);
			break;
		case 'next':
		default:
			startDate.setMinutes(Math.floor(startDate.getMinutes() / (resolution / 60000)) * (resolution / 60000) + resolution / 60000);
	}


	if (startDate.getTime() > end) {
		startDate = new Date(start);
		timeline = new Timeline(13, document.getElementById("timeline"));
	} else if (startDate.getTime() < start) {
		startDate = new Date(end);
	}
		
		if (startDate.getTime() == end && animationId === null) {
			IS_FOLLOWING = true;
			localStorage.setItem("IS_FOLLOWING",JSON.stringify(true));
			debug('MODE: FOLLOW');
			document.getElementById("skipNextButton").classList.add("selectedButton");
		} else {
			IS_FOLLOWING = false;
			localStorage.setItem("IS_FOLLOWING",JSON.stringify(false));
			document.getElementById("skipNextButton").classList.remove("selectedButton");
		}

		//updateTimeLine((startDate.getTime()-start)/resolution);
		timeline.update((startDate.getTime()-start)/resolution);

		//var startDateFormat = moment(startDate.toISOString()).utc().format()
		//debug("---");
		//debug(startDateFormat);
		//debug(startDate.toISOString());
		if (VISIBLE.has("satelliteLayer")) setLayerTime(satelliteLayer, startDate.toISOString());
		if (VISIBLE.has("radarLayer")) setLayerTime(radarLayer, startDate.toISOString());
		if (VISIBLE.has("lightningLayer")) setLayerTime(lightningLayer, 'PT'+(resolution/60000)+'M/' + startDate.toISOString());
		if (VISIBLE.has("observationLayer")) setLayerTime(observationLayer, 'PT'+(resolution/60000)+'M/' + startDate.toISOString());

}

const currentDateValueDiv = document.getElementById("currentDateValue");
const currentLocalTimeValueDiv = document.getElementById("currentLocalTimeValue");
const currentUTCTimeValueDiv = document.getElementById("currentUTCTimeValue");

function updateClock() {
    const d = dayjs();
    const date = d.format('l');
    const time = d.format('LTS');
    const utc = d.utc().format('LTS') + ' UTC';

    // Batch DOM updates to minimize reflow
    if (currentDateValueDiv.textContent !== date) {
        currentDateValueDiv.textContent = date;
    }
    if (currentLocalTimeValueDiv.textContent !== time) {
        currentLocalTimeValueDiv.textContent = time;
    }
    if (currentUTCTimeValueDiv.textContent !== utc) {
        currentUTCTimeValueDiv.textContent = utc;
    }

    // Use requestAnimationFrame for better performance and sync with display refresh
    requestAnimationFrame(() => {
        setTimeout(updateClock, 1000);
    });
}


//
// TIME CONTROLS
//

var play = function () {
	if (animationId === null) {
		debug("PLAY");
		IS_FOLLOWING = false;
		animationId = window.setInterval(setTime, 1000 / options.frameRate);
		document.getElementById("playstopButton").innerHTML = "pause";
	}
};

var stop = function () {
	if (animationId !== null) {
		debug("STOP");
		IS_FOLLOWING = false;
		window.clearInterval(animationId);
		animationId = null;
		document.getElementById("playstopButton").innerHTML = "play_arrow";
	}
};

var skip_next = function () {
	debug("NEXT");
	IS_FOLLOWING = false;
	stop();
	setTime('next');
}

var skip_previous = function () {
	debug("PREVIOUS");
	IS_FOLLOWING = false;
	stop();
	setTime('previous');
}

var playstop = function () {
	IS_FOLLOWING = false;
	if (animationId !== null) {
		stop();
	} else {
		play();
	}
};

// Start Animation
//document.getElementById("infoItemPosition").style.display = "none";
document.getElementById("cursorDistanceTxt").style.display = "none";



function setMapLayer(maplayer) {
	debug('Set ' + maplayer + ' map.');
	switch (maplayer) {
		case 'light':
			darkGrayBaseLayer.setVisible(false);
			darkGrayReferenceLayer.setVisible(false);
			lightGrayBaseLayer.setVisible(true);
			lightGrayReferenceLayer.setVisible(true);
			document.getElementById("mapLayerButton").classList.remove("selectedButton");
			IS_DARK = false;
			typeof umami !== 'undefined' && umami.track('theme-light');
			break;
		case 'dark':
			darkGrayBaseLayer.setVisible(true);
			darkGrayReferenceLayer.setVisible(true);
			lightGrayBaseLayer.setVisible(false);
			lightGrayReferenceLayer.setVisible(false);
			document.getElementById("mapLayerButton").classList.add("selectedButton");
			IS_DARK = true;
			typeof umami !== 'undefined' && umami.track('theme-dark');
			break;	
	}
	localStorage.setItem("IS_DARK",JSON.stringify(IS_DARK));
}

document.getElementById('darkBase').addEventListener('mouseup', function (event) {
	event.target.classList.add("selected");
	document.getElementById("lightBase").classList.remove("selected");
	setMapLayer('dark');
});

document.getElementById('lightBase').addEventListener('mouseup', function (event) {
	event.target.classList.add("selected");
	document.getElementById("darkBase").classList.remove("selected");
	setMapLayer('light');
});

function removeSelectedParameter(selector) {
	var els = document.querySelectorAll(selector);
	els.forEach(function (elem) {
		elem.classList.remove('selected');
	});
}

function updateLayer(layer, wmslayer) {
	debug("Activated layer " + wmslayer);
	debug(layerInfo[wmslayer]);
	var info = layerInfo[wmslayer];
	layer.set('info', info);
	if (document.getElementById(wmslayer)) {
		removeSelectedParameter("#" + layer.get("name") + " > div");
		document.getElementById(wmslayer).classList.add("selected");
	}
	if (info && info.url) {
		layer.setLayerUrl(info.url);
	}
	layer.getSource().updateParams({ 'LAYERS': wmslayer });
	if (layer.getVisible()) {
		updateCanonicalPage();
	} else {
		layer.setVisible(true);
	}
	updateLayerSelectionSelected();
}

function addEventListeners(selector) {
	let elementsArray = document.querySelectorAll(selector);
	elementsArray.forEach(function (elem) {
		debug("Activated event listener for " + elem.id);
		elem.addEventListener("mouseup", function (event) {
			if (event.target.id.indexOf("Off") !== -1) {
				event.target.classList.add("selected");
				layerss[event.target.parentElement.id].setVisible(false);
			} else {
				updateLayer(layerss[event.target.parentElement.id], event.target.id);
			}
		});
	});
}



var highlightStyle = new Style({
	stroke: new Stroke({
		color: '#f00',
		width: 1
	}),
	fill: new Fill({
		color: 'rgba(255,0,0,0.1)'
	}),
	text: new Text({
		font: '12px Calibri,sans-serif',
		fill: new Fill({
			color: '#000'
		}),
		stroke: new Stroke({
			color: '#f00',
			width: 3
		}),
		offsetX: 0,
		offsetY: -20
	})
});

var featureOverlay = new VectorLayer({
	source: new Vector(),
	map: map,
	style: function (feature) {
		return style;
	}
});
var highlight;

var displayFeatureInfo = function (pixel) {
	var feature = map.forEachFeatureAtPixel(pixel, function (feature) {
		return feature;
	});

	if (feature !== highlight) {
		if (highlight) {
			featureOverlay.getSource().removeFeature(highlight);
			guideLayer.getSource().clear(true);
		}
		if (feature && feature.getGeometry().getType() === 'Point') {
			featureOverlay.getSource().addFeature(feature);
			var coords = transform(feature.getGeometry().getCoordinates(), map.getView().getProjection(), 'EPSG:4326');
			[50000,100000,150000,200000,250000].forEach(range => rangeRings(guideLayer, coords, range));
			Array.from({length:360/options.radialSpacing},(x,index)=>index*options.radialSpacing).forEach(bearing => bearingLine(guideLayer, coords, 250, bearing));
			map.getView().fit(guideLayer.getSource().getExtent(), map.getSize()); 
		}
		highlight = feature;
	}
};

function createLayerInfoElement(content, style, isHTML) {
	let div = document.createElement('div');
	div.classList.add(style);
	if (typeof content !== "undefined" && content !== null) {
		if (isHTML) {
			div.innerHTML = content;
		} else {
			div.textContent = content;
		}
	}
	return div;
}

function emptyElement(element){
  var i = element.childNodes.length;
  while(i--){
    element.removeChild(element.lastChild);
  }
}

function layerInfoDiv(wmslayer) {
	let info = layerInfo[wmslayer];
	let div = document.createElement('div');
	var resolution = info && info.time ? Math.round(info.time.resolution/60000) : 0;

	div.id = wmslayer + 'Meta';
	div.setAttribute('data-layer-name', wmslayer);
	div.setAttribute('data-layer-category', info ? info.category : '');

	div.appendChild(createLayerInfoElement(info ? info.title : '', 'title'));

	var previewDiv = document.createElement('div');
	previewDiv.classList.add('preview');
	if (info && info.url && info.layer) {
		var img = document.createElement('img');
		img.className = 'responsiveImage';
		img.loading = 'lazy';
		img.src = info.url + '?TIME=PT1H/PRESENT&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image%2Fpng8&TRANSPARENT=true&CRS=EPSG%3A3067&STYLES=&WIDTH=300&HEIGHT=300&BBOX=-183243.50620644476%2C6575998.62606195%2C1038379.8685031873%2C7797622.000771582&LAYERS=' + encodeURIComponent(info.layer);
		previewDiv.appendChild(img);
	}
	div.appendChild(previewDiv);
	div.appendChild(createLayerInfoElement(info ? info.abstract : '', 'abstract'));
	if (info && info.time && info.time.end) {
		div.appendChild(createLayerInfoElement((resolution > 60 ? (resolution / 60) + ' tuntia ' : resolution + ' minuuttia, viimeisin: ')+dayjs(info.time.end).format('LT'),'time'));
	} else {
		div.appendChild(createLayerInfoElement('Aikatiedot ei saatavilla','time'));
	}
	if (info && info.attribution && info.attribution.Title) {
		div.appendChild(createLayerInfoElement(info.attribution.Title,'attribution'));
	} else {
		div.appendChild(createLayerInfoElement('','attribution'));
	}
	return div;
}

var _playlistSliderHandlers = {};

function layerInfoPlaylist(event) {
	const layer = event.target;
	const name = layer.get('name')
	const info = layer.get('info')
	let opacity = layer.get('opacity') * 100

	if (typeof info === "undefined") return

	// Only do full DOM rebuild when playlist is visible
	var playList = document.getElementById('playList');
	if (playList.style.display === 'none' || playList.offsetParent === null) {
		// Still update the visibility class (cheap)
		if (layer.getVisible()) {
			document.getElementById(name + 'Info').classList.remove("playListDisabled");
		} else {
			document.getElementById(name + 'Info').classList.add("playListDisabled");
		}
		return;
	}

	debug("Updating playlist for " + name);

	if (typeof info.style !== "undefined") {
		if (info.style.length > 1) {
			const parent = document.getElementById(name + 'Styles');
			while (parent.firstChild) parent.removeChild(parent.firstChild);
			info.style.forEach(style => {
				let div = document.createElement("div");
				div.textContent = style.Title;
				div.id = style.Name;
				div.addEventListener('mouseup', function () { layer.setLayerStyle(style.Name) });
				parent.appendChild(div);
			});
		} else {
			document.getElementById(name + 'Styles').textContent = "";
		}
	} else {
		document.getElementById(name + 'Styles').textContent = "";
	}

	document.getElementById(name + 'Title').textContent = info.title || "";
	document.getElementById(name + 'Abstract').textContent = info.abstract || "";
	document.getElementById(name + 'Attribution').textContent = (info.attribution && info.attribution.Title) || "";

	// Build slider without innerHTML
	var opacityContainer = document.getElementById(name + 'Opacity');
	opacityContainer.textContent = '';
	var label = document.createElement('label');
	label.setAttribute('for', name + 'Slider');
	label.textContent = 'Läpikuultavuus';
	var slider = document.createElement('input');
	slider.type = 'range';
	slider.min = '1';
	slider.max = '100';
	slider.value = opacity;
	slider.className = 'slider';
	slider.id = name + 'Slider';
	opacityContainer.appendChild(label);
	opacityContainer.appendChild(slider);

	if (layer.getVisible()) {
		document.getElementById(name + 'Info').classList.remove("playListDisabled");
	} else {
		document.getElementById(name + 'Info').classList.add("playListDisabled");
	}

	// Remove previous slider listener to prevent leaks
	if (_playlistSliderHandlers[name]) {
		slider.removeEventListener('input', _playlistSliderHandlers[name]);
	}
	_playlistSliderHandlers[name] = function (e) {
		layer.setOpacity(e.target.value / 100);
		e.stopPropagation();
	};
	slider.addEventListener('input', _playlistSliderHandlers[name]);
}

function onChangeVisible (event) {
	const layer = event.target;
	const wmslayer = layer.getSource().getParams().LAYERS;
	let name = layer.get('name');
	let isVisible = layer.getVisible();
	removeSelectedParameter("#" + name + " > div");
	if (isVisible) {
		debug("Activated " + name);
		VISIBLE.add(name);
		localStorage.setItem("VISIBLE",JSON.stringify([...VISIBLE]));
		if (document.getElementById(wmslayer)) {
			document.getElementById(wmslayer).classList.add("selected");
		}
		document.getElementById(name+"Button").classList.add("selectedButton");
		document.getElementById(name+'Info').classList.remove("playListDisabled");
	} else {
		debug("Deactivated " + name);
		VISIBLE.delete(name);
		localStorage.setItem("VISIBLE",JSON.stringify([...VISIBLE]));
		document.getElementById(name+"Off").classList.add("selected");
		document.getElementById(name+"Button").classList.remove("selectedButton");
		document.getElementById(name+'Info').classList.add("playListDisabled");
	}
	updateCanonicalPage();
	updateLayerSelectionSelected();
}

function onChangeSlider () {
	debug(this.value);
	radarLayer.setOpacity(this.value/100);
}

/**
 * Toggles the visibility of a given layer.
 * If the layer is currently visible, it will be set to invisible, and vice versa.
 *
 * @param {ol.layer} layer - The layer whose visibility will be toggled.
 */
function toggleLayerVisibility(layer) {
	layer.setVisible(!layer.getVisible());
}

//
// EVENTS
//

document.getElementById('speedButton').addEventListener('mouseup', function() {
	switch(options.frameRate) {
		case options.defaultFrameRate:
			options.frameRate = options.defaultFrameRate * 2;
			break;
		case options.defaultFrameRate * 2:
			options.frameRate = options.defaultFrameRate * 0.5;
			break;
		default:
		options.frameRate = options.defaultFrameRate
	}
	document.getElementById('speedButton').innerHTML = options.frameRate / options.defaultFrameRate + "×";
	stop();
	play();
	debug("SPEED: " + options.frameRate);
	//gtag('event', 'speed', {'event_category' : 'timecontrol', 'event_label' : options.frameRate / options.defaultFrameRate + "×"});
});

document.getElementById('playButton').addEventListener('mouseup', function() {
	playstop();
});

document.getElementById('skipNextButton').addEventListener('mouseup', function() {
	skip_next();
});

document.getElementById('skipPreviousButton').addEventListener('mouseup', function() {
	skip_previous();
});

document.getElementById('playlistButton').addEventListener('mouseup', function() {
	debug("playlist");
	var elem = document.getElementById("playList");
	if (elem.style.bottom === '0px') {
		elem.style.bottom = '-90vh';
	} else {
		elem.style.bottom = '0px';
	}
});

// Close playlist if clicked outside of playlist
window.addEventListener('mouseup', function (e) {
	// playlist
	if (!document.getElementById('playList').contains(e.target)) {
		if (document.getElementById('playlistButton').contains(e.target)) return
		var elem = document.getElementById("playList");
		if (elem.style.bottom === '0px') {
			elem.style.bottom = '-90vh';
		} 
	}

	// Layers
	if (!document.getElementById('layers').contains(e.target)) {
		if (document.getElementById('layersButton').contains(e.target)) return
		var elem = document.getElementById("layers");
		//if (elem.style.display === 'block') {
			elem.style.display = 'none';
		//} 
	}

	// Close long-press menus when clicking/touching outside
	var longPressMenus = [
		{ menuId: 'observationLongPressMenu', buttonId: 'observationLayerButton' },
		{ menuId: 'satelliteLongPressMenu', buttonId: 'satelliteLayerButton' },
		{ menuId: 'radarLongPressMenu', buttonId: 'radarLayerButton' }
	];
	longPressMenus.forEach(function(cfg) {
		if (!document.getElementById(cfg.menuId).contains(e.target)) {
			if (document.getElementById(cfg.buttonId).contains(e.target)) return;
			document.getElementById(cfg.menuId).style.display = 'none';
		}
	});
});

window.addEventListener('touchend', function (e) {
	var longPressMenus = [
		{ menuId: 'observationLongPressMenu', buttonId: 'observationLayerButton' },
		{ menuId: 'satelliteLongPressMenu', buttonId: 'satelliteLayerButton' },
		{ menuId: 'radarLongPressMenu', buttonId: 'radarLayerButton' }
	];
	longPressMenus.forEach(function(cfg) {
		if (!document.getElementById(cfg.menuId).contains(e.target)) {
			if (document.getElementById(cfg.buttonId).contains(e.target)) return;
			document.getElementById(cfg.menuId).style.display = 'none';
		}
	});
});

function setButtonStates() {
	if (IS_TRACKING) {
		document.getElementById("locationLayerButton").classList.add("selectedButton");
	} else {
		document.getElementById("locationLayerButton").classList.remove("selectedButton");
	}
	if (IS_DARK) {
		document.getElementById("mapLayerButton").classList.add("selectedButton");
	} else {
		document.getElementById("mapLayerButton").classList.remove("selectedButton");
	}
	if (VISIBLE.has("satelliteLayer")) {
		document.getElementById("satelliteLayerButton").classList.add("selectedButton");
	} else {
		document.getElementById("satelliteLayerButton").classList.remove("selectedButton");
	}
	if (VISIBLE.has("radarLayer")) {
		document.getElementById("radarLayerButton").classList.add("selectedButton");
	} else {
		document.getElementById("radarLayerButton").classList.remove("selectedButton");
	}
	if (VISIBLE.has("lightningLayer")) {
		document.getElementById("lightningLayerButton").classList.add("selectedButton");
	} else {
		document.getElementById("lightningLayerButton").classList.remove("selectedButton");
	}
	if (VISIBLE.has("observationLayer")) {
		document.getElementById("observationLayerButton").classList.add("selectedButton");
	} else {
		document.getElementById("observationLayerButton").classList.remove("selectedButton");
	}
}

document.getElementById('locationLayerButton').addEventListener('mouseup', function() {
	if (IS_TRACKING) {
		IS_TRACKING = false;
		localStorage.setItem("IS_TRACKING",JSON.stringify(false));
		geolocation.setTracking(false);
		ownPositionLayer.setVisible(false);
		typeof umami !== 'undefined' && umami.track('tracking-off');
	} else {
		IS_TRACKING = true;
		localStorage.setItem("IS_TRACKING",JSON.stringify(true));
		geolocation.setTracking(true);
		ownPositionLayer.setVisible(true);
		if (ownPosition.length > 1) {
			map.getView().setCenter(ownPosition);
		}
		typeof umami !== 'undefined' && umami.track('tracking-on');
	}
	setButtonStates();
});

document.getElementById('cursorDistanceTxt').addEventListener('mouseup', function() {
	IS_NAUTICAL = IS_NAUTICAL ? false : true;
	localStorage.setItem("IS_NAUTICAL",JSON.stringify(IS_NAUTICAL));
});

document.getElementById('mapLayerButton').addEventListener('mouseup', function() {
	if (IS_DARK) {
		setMapLayer('light');
	} else {
		setMapLayer('dark');
	}
});



document.getElementById('radarLayerTitle').addEventListener('mouseup', function() {
	toggleLayerVisibility(radarLayer);
});

document.getElementById('lightningLayerButton').addEventListener('mouseup', function() {
	toggleLayerVisibility(lightningLayer);
});

document.getElementById('lightningLayerTitle').addEventListener('mouseup', function() {
	toggleLayerVisibility(lightningLayer);
});

// Long press functionality for observation layer button
// Generic long-press menu handler
function createLongPressHandler(buttonId, menuId, olLayer, onSelect) {
	var timer = null;
	var triggered = false;
	var startTime = 0;
	var button = document.getElementById(buttonId);

	function showMenu(e) {
		var menu = document.getElementById(menuId);
		var menuItems = menu.querySelectorAll('.menu-item');
		var currentLayer = olLayer.getSource().getParams().LAYERS;
		var isVisible = olLayer.getVisible();
		menuItems.forEach(function(item) {
			item.classList.toggle('selected', isVisible && item.getAttribute('data-layer') === currentLayer);
		});

		var vw = window.innerWidth, vh = window.innerHeight;
		var br = button.getBoundingClientRect();
		menu.style.display = 'block';
		menu.style.visibility = 'hidden';
		var mr = menu.getBoundingClientRect();
		var left = Math.max(10, Math.min(br.left, vw - mr.width - 10));
		var top = br.bottom + 5;
		if (top + mr.height > vh - 10) {
			top = Math.max(10, br.top - mr.height - 5);
		}
		menu.style.left = left + 'px';
		menu.style.top = top + 'px';
		menu.style.visibility = 'visible';
	}

	function hideMenu() {
		document.getElementById(menuId).style.display = 'none';
	}

	function start(e) {
		triggered = false;
		startTime = Date.now();
		timer = setTimeout(function() {
			triggered = true;
			showMenu(e);
		}, 500);
	}

	function end() {
		clearTimeout(timer);
		if (!triggered && Date.now() - startTime < 500) {
			toggleLayerVisibility(olLayer);
		}
	}

	function cancel() {
		clearTimeout(timer);
		triggered = false;
	}

	button.addEventListener('mousedown', start);
	button.addEventListener('mouseup', end);
	button.addEventListener('mouseleave', cancel);
	button.addEventListener('touchstart', function(e) { e.preventDefault(); start(e); });
	button.addEventListener('touchend', function(e) { e.preventDefault(); end(e); });
	button.addEventListener('touchmove', function(e) { e.preventDefault(); cancel(); });
	button.addEventListener('touchcancel', function(e) { e.preventDefault(); cancel(); });

	// Menu item click/touch handlers
	document.querySelectorAll('#' + menuId + ' .menu-item').forEach(function(item) {
		item.addEventListener('click', function() {
			onSelect(this.getAttribute('data-layer'));
		});
		item.addEventListener('touchend', function(e) {
			e.preventDefault();
			e.stopPropagation();
			onSelect(this.getAttribute('data-layer'));
		});
	});

	return { show: showMenu, hide: hideMenu };
}

var observationMenu = createLongPressHandler('observationLayerButton', 'observationLongPressMenu', observationLayer, function(id) {
	updateLayer(observationLayer, id);
	observationMenu.hide();
});

var satelliteMenu = createLongPressHandler('satelliteLayerButton', 'satelliteLongPressMenu', satelliteLayer, function(id) {
	updateLayer(satelliteLayer, id);
	satelliteMenu.hide();
});

var radarMenu = createLongPressHandler('radarLayerButton', 'radarLongPressMenu', radarLayer, function(id) {
	updateLayer(radarLayer, id);
	radarMenu.hide();
});

document.getElementById('layersButton').addEventListener('mouseup', function() {
	let div = document.getElementById('layers');
	if (div.style.display === 'none') {
		div.style.display = 'grid';
	} else {
		div.style.display = 'none';
	}
});

// document.addEventListener('click', function (event) {
// 	debug(event);
// 	if (event.target.closest('#satelliteLayerButton')) {
// 		toggleLayerVisibility(satelliteLayer);
// 	}

// 	if (event.target.closest('#radarLayerButton')) {
// 		toggleLayerVisibility(radarLayer);
// 	}

// 	if (event.target.closest('#lightningLayerButton')) {
// 		toggleLayerVisibility(lightningLayer);
// 	}

// 	if (event.target.closest('#observationLayerButton')) {
// 		toggleLayerVisibility(observationLayer);
// 	}
// });




document.addEventListener('keyup', function (event) {
	if (event.defaultPrevented) {
		return;
	}

	var key = event.key || event.keyCode;
	if (key === ' ' || key === 'Space' || key === 32) {
		skip_next();
	} else if (key === ',' || key === 'Comma') {
		skip_previous(); 
	} else if (key === '.' || key === 'Period') {
		skip_next(); 
	} else if (key === 'j' || key === 'KeyJ') {
		skip_previous(); 
	} else if (key === 'k' || key === 'KeyK') {
		playstop(); 
	} else if (key === 'l' || key === 'KeyL') {
		skip_next(); 
	} else if (key === '1' || key === 'Digit1') {
		toggleLayerVisibility(satelliteLayer);
	} else if (key === '2' || key === 'Digit2') {
		toggleLayerVisibility(radarLayer);    
	} else if (key === '3' || key === 'Digit3') {
		toggleLayerVisibility(lightningLayer);    
	} else if (key === '4' || key === 'Digit4') {
		toggleLayerVisibility(observationLayer);    
	} else 	if (event.key === 'Control') {
		document.getElementById('help').style.display = "none";
	} else 	if (event.key === 'Home') {
		stop();
		setTime('last');
	} else {
		debug(event);
	}

});

function updateLayerSelection(ollayer,type,filter) {
	//debug(type)
	//debug(ollayer)
	let parent = document.getElementById('layers');
	document.querySelectorAll('.'+type+'LayerSelect').forEach(function(child) {
    parent.removeChild(child);
	});
	Object.keys(layerInfo).sort().forEach((layer) => {
		if (layerInfo[layer].layer.includes(filter)) {
			let div = layerInfoDiv(layer); 
			div.onclick = function () { 
				if (ollayer.getVisible() && getActiveLayers().includes(layer)) {
					ollayer.setVisible(false);
				} else {
					updateLayer(ollayer,layerInfo[layer].layer);
				} 
			};
			div.classList.add(type+'LayerSelect');
			div.classList.add('layerSelectItem');
			const ollayerInfo = ollayer.get('info');
			if (ollayerInfo && ollayerInfo.layer === layer) {
				div.classList.add("selectedLayer");
			}
			document.getElementById("layers").appendChild(div);
		}
	});
	updateLayerSelectionSelected();
}

function updateLayerSelectionSelected() {
	debug("UPDATE Layer Selection Selected called");
	let activeLayers = getActiveLayers();
	document.querySelectorAll('.layerSelectItem').forEach(function (div) {
		div.classList.remove("selectedLayer");
		if (VISIBLE.has(div.getAttribute('data-layer-category'))) {
			if (activeLayers.includes(div.getAttribute('data-layer-name'))) {
				div.classList.add("selectedLayer");
			}
		}
	});
}

function getWMSCapabilities(wms) {
	var parser = new WMSCapabilities();
	let namespace = wms.namespace ? '&namespace=' + wms.namespace : '';
	let layer = wms.layer ? '&layer=' + wms.layer : '';
	debug("Request WMS Capabilities " + wms.url);
	//gtag('event', 'getCapabilities', {
	//	'event_category': 'WMS',
	//	'event_label': wms.url
	//});
	fetch(wms.url + '?SERVICE=WMS&version=1.3.0&request=GetCapabilities' + namespace + layer).then(function (response) {
		return response.text();
	}).then(function (text) {
		debug("Received WMS Capabilities " + wms.url);
		var result = parser.read(text);
		if (result && result.Capability && result.Capability.Layer && result.Capability.Layer.Layer) {
			getLayers(result.Capability.Layer.Layer, wms);
			debug(layerInfo);
			satelliteLayer.set('info', layerInfo[satelliteLayer.getSource().getParams().LAYERS])
			radarLayer.set('info', layerInfo[radarLayer.getSource().getParams().LAYERS])
			lightningLayer.set('info', layerInfo[lightningLayer.getSource().getParams().LAYERS])
			observationLayer.set('info', layerInfo[observationLayer.getSource().getParams().LAYERS])
			switch (wms.category) {
				case 'satelliteLayer':
					updateLayerSelection(satelliteLayer, "satellite", "msg_");
					break;
				case 'observationLayer':
					updateLayerSelection(observationLayer, "observation", "observation:");
					break;
				case 'radarLayer':
					updateLayerSelection(radarLayer, "radar", "suomi_");
					break;
				case 'lightningLayer':
					updateLayerSelection(lightningLayer, "lightning", "lightning");
					break;
				default:
					debug('No wms.category set');
			}
			if (IS_FOLLOWING) {
				setTime('last');
			}
		} else {
			debug('Invalid WMS Capabilities response structure for ' + wms.url);
			debug(result);
		}
	}).catch(function (error) {
		debug('Error fetching WMS Capabilities from ' + wms.url + ': ' + error.message);
	}).finally(function () {
		setTimeout(function () { getWMSCapabilities(wms) }, wms.refresh);
	});
}

function getLayers(parentlayer,wms) {
	let products = {}
	parentlayer.forEach((layer) => {
		if (Array.isArray(layer.Layer)) {
			getLayers(layer.Layer,wms)
		} else {
			var name = layer.Name;
			// FMI GeoServer returns unprefixed names; meteo.fi returns prefixed.
			// Add namespace prefix only when it's not already present.
			if (wms.namespace && name.indexOf(wms.namespace + ':') !== 0) {
				name = wms.namespace + ':' + name;
			}
			layerInfo[name] = getLayerInfo(layer,wms)
			layerInfo[name].layer = name;
		}
	})
	return products;
}

function getLayerInfo(layer,wms) {
	let product =
	{
		category: wms.category,
		url: wms.url,
		layer: layer.Name
	}

	if (typeof layer.CRS !== "undefined") {
		product.crs = layer.CRS[0];
	} else {
		product.crs = 'EPSG:4326';
	}

	if (typeof wms.title !== "undefined") {
		product.title = wms.title;
	} else {
		product.title = layer.Title;
	}

	if (typeof wms.abstract !== "undefined") {
		product.abstract = wms.abstract;
	} else {
		product.abstract = layer.Abstract;
	}

	if (typeof layer.Attribution !== "undefined") {
		product.attribution = layer.Attribution;
	} else if (typeof wms.attribution !== "undefined") {
		product.attribution = {Title: wms.attribution};
	}

	if (typeof layer.Dimension !== "undefined") {
		product.time = getTimeDimension(layer.Dimension);
	}

	if (typeof layer.Style !== "undefined") {
		product.style = layer.Style;
	}
	return product
}

function getTimeDimension(dimensions) {
	//var time = {}
	var beginTime
	var endTime
	var resolutionTime
	var prevtime
	var defaultTime

	dimensions.forEach((dimension) => {
		if (dimension.name == 'time') {
			defaultTime = dimension.default ? dayjs(dimension.default).valueOf() : NaN
			dimension.values.split(",").forEach((times) => {
				var time = times.split("/")
				// Time dimension is list of times separated by comma
				if (time.length == 1) {
					//var timeValue = dayjs(time[0]).valueOf()
					var timeValue = dayjs(new Date(time[0])).valueOf()
					// begin time is the smallest of listed times
					beginTime = beginTime ? beginTime : timeValue
					beginTime = Math.min(beginTime, timeValue)
					// end time is the bigest of listed times
					endTime = endTime ? endTime : timeValue
					endTime = Math.max(endTime, timeValue)
					// resolution is the difference of the last two times listed
					resolutionTime = prevtime ? (timeValue - prevtime) : 3600000
					prevtime = timeValue
				}
				// Time dimension is starttime/endtime/period
				else if (time.length == 3) {
					beginTime = dayjs(time[0]).valueOf()
					endTime = dayjs(time[1]).valueOf()
					resolutionTime = dayjs.duration(time[2]).asMilliseconds()
				}
			}) // forEach
		} // if
	}) // forEach
	var currentTime = new Date().getTime()
	var type = endTime > currentTime ? "for" : "obs"
	//console.log("start: " + beginTime + " end: " + endTime + " resolution: " + resolutionTime + " type: " + type + " default: " + defaultTime)
	return { start: beginTime, end: endTime, resolution: resolutionTime, type: type, default: defaultTime }
}


//
// MAIN
//
const main = () => {
	
	timeline = new Timeline (13, document.getElementById("timeline"));

	setMapLayer(IS_DARK ? 'dark' : 'light');

	updateClock();

    trackPWAUsage();

	for (const [key, value] of Object.entries(options.wmsServerConfiguration)) {
		if (!value.disabled) {
			getWMSCapabilities(value);
		}
	}
	
	setButtonStates();

	// GEOLOCATION
	geolocation = new Geolocation({
		trackingOptions: {
			enableHighAccuracy: true
		},
		projection: map.getView().getProjection()
	});
	
	geolocation.on('error', function (error) { debug(error.message) });
	geolocation.on('change:accuracyGeometry',onChangeAccuracyGeometry);
	geolocation.on('change:position', onChangePosition);
	geolocation.on('change:speed', onChangeSpeed);

	// Layers
	satelliteLayer.on('change:visible', onChangeVisible);
	satelliteLayer.on('propertychange', layerInfoPlaylist);
	radarLayer.on('change:visible', onChangeVisible);
	radarLayer.on('propertychange', layerInfoPlaylist);
	lightningLayer.on('change:visible', onChangeVisible);
	lightningLayer.on('propertychange', layerInfoPlaylist);
	observationLayer.on('change:visible', onChangeVisible);
	observationLayer.on('propertychange', layerInfoPlaylist);

	addEventListeners("#satelliteLayer > div");
	addEventListeners("#radarLayer > div");
	addEventListeners("#lightningLayer > div");
	addEventListeners("#observationLayer > div");

	map.on('click', function(evt) {
		displayFeatureInfo(evt.pixel);
	});

	map.on('moveend', function(evt) {
		const zoom = Math.min(map.getView().getZoom(),16);
		localStorage.setItem("metZoom",zoom);
	});
	
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Control') {
			document.getElementById('help').style.display = "block";
		}
	});

	window.matchMedia("(prefers-color-scheme: dark)").addEventListener('change', function(x) {
		if (x.matches) {
			setMapLayer('dark');
		} else {
			setMapLayer('light');
		}
	});


	if (IS_FOLLOWING) {
		setTime('last');
	} else {
		play();
	}

	if (IS_TRACKING) {
		geolocation.setTracking(true);
		ownPositionLayer.setVisible(true);
	}

	// Position map
	if (metPosition.length > 1) {
		map.getView().setCenter(metPosition);
		map.getView().setZoom(metZoom);
	} else {
		map.getView().fit(transformExtent([19.24, 58.5, 31.59, 71.0],'EPSG:4326', map.getView().getProjection()));
	}
	sync(map);

};



function trackPWAUsage() {
    const displayMode = window.matchMedia('(display-mode: standalone)').matches ? 'standalone' :
                        window.matchMedia('(display-mode: fullscreen)').matches ? 'fullscreen' :
                        window.matchMedia('(display-mode: minimal-ui)').matches ? 'minimal-ui' :
                        'browser';
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    
    typeof umami !== 'undefined' && umami.track('app-display', { 'display-mode': displayMode, 'color-scheme': colorScheme });
	typeof umami !== 'undefined' && umami.track('version', { 'build-date': BUILD_DATE, 'openlayers': OL_VERSION });
}

// Listen for the appinstalled event
window.addEventListener('appinstalled', (e) => {
	debug('PWA was installed');
	// Track successful PWA installation
	typeof umami !== 'undefined' && umami.track('pwa-installed');
	// Clear the deferredPrompt
});

main();