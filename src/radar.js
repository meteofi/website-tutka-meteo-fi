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
import wmsServerConfiguration from './config';
import createLongPressHandler from './longpress';
import dayjs from 'dayjs';
import 'dayjs/locale/fi';
import utcPlugin from 'dayjs/plugin/utc';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import durationPlugin from 'dayjs/plugin/duration';
import {VERSION as OL_VERSION} from 'ol/util';

dayjs.locale('fi');
dayjs.extend(utcPlugin);
dayjs.extend(localizedFormat);
dayjs.extend(durationPlugin);

const options = {
	defaultRadarLayer: 'fmi-radar-composite-dbz',
	defaultLightningLayer: 'observation:lightning',
	defaultObservationLayer: 'observation:airtemperature',
	rangeRingSpacing: 50,
	radialSpacing: 30,
	frameRate: 2, // fps
	defaultFrameRate: 2, // fps
	imageRatio: 1.5,
	wmsServerConfiguration: wmsServerConfiguration
}

let DEBUG = false;

function safeParseJSON(key, fallback) {
	try { const v = JSON.parse(localStorage.getItem(key)); return v != null ? v : fallback; }
	catch (e) { return fallback; }
}

let metLatitude = Number(localStorage.getItem('metLatitude')) || 60.2706;
let metLongitude = Number(localStorage.getItem('metLongitude')) || 24.8725;
let metPosition = safeParseJSON('metPosition', []);
let metZoom = Number(localStorage.getItem('metZoom')) || 9;
let ownPosition = [];
let ownPosition4326 = [];
let geolocation;
let startDate = new Date(Math.floor(Date.now() / 300000) * 300000 - 300000 * 12);
let animationId = null;
const layerInfo = {};
let timeline;
let mapTime = '';

let VISIBLE = new Set(safeParseJSON('VISIBLE', ['radarLayer']));
let ACTIVE = new Set(safeParseJSON('ACTIVE', [options.defaultRadarLayer]));

// Migrate deprecated FMI openwms layer to meteocore equivalent
if (ACTIVE.has('suomi_dbz_eureffin')) {
	ACTIVE.delete('suomi_dbz_eureffin');
	ACTIVE.add('fmi-radar-composite-dbz');
	localStorage.setItem('ACTIVE', JSON.stringify([...ACTIVE]));
}
let IS_DARK = safeParseJSON('IS_DARK', true);
let IS_TRACKING = safeParseJSON('IS_TRACKING', false);
let IS_FOLLOWING = safeParseJSON('IS_FOLLOWING', false);
let IS_NAUTICAL = safeParseJSON('IS_NAUTICAL', false);

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
	typeof umami !== 'undefined' && umami.track('layer-style', { style: style, category: this.get('name') });
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
const style = new Style({
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

const radarStyle = new Style({
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

const icaoStyle = new Style({
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

const ownStyle = new Style({
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

const rangeStyle = new Style({
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
const positionFeature = new Feature();
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

const accuracyFeature = new Feature();
accuracyFeature.setStyle(new Style({
	fill: new Fill({
		color: [128,128,128,0.3]
	}),
}));

//
// LAYERS
//
const imageryBaseLayer = new TileLayer({
	visible: false,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/World_Imagery/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'World_Imagery/MapServer/tile/{z}/{y}/{x}'
	})
});

const lightGrayBaseLayer = new TileLayer({
	visible: false,
	preload: Infinity,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Light_Gray_Base/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
	})
});

const lightGrayReferenceLayer = new TileLayer({
	visible: false,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Light_Gray_Reference/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
	})
});

const darkGrayBaseLayer = new TileLayer({
	preload: Infinity,
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Dark_Gray_Base/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
	})
});

const darkGrayReferenceLayer = new TileLayer({
	source: new XYZ({
		attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
			'rest/services/Canvas/World_Dark_Gray_Reference/MapServer">ArcGIS</a>',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
			'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
	})
});

// Satellite Layer
const satelliteLayer = new ImageLayer({
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
const radarLayer = new ImageLayer({
	name: "radarLayer",
	visible: VISIBLE.has("radarLayer"),
	opacity: 0.7,
	source: new ImageWMS({
		url: options.wmsServerConfiguration.fi.url,
		params: { 'LAYERS': options.defaultRadarLayer },
		attributions: 'FMI (CC-BY-4.0)',
		ratio: options.imageRatio,
		hidpi: false,
		serverType: 'geoserver'
	})
});

// Lightning Layer
const lightningLayer = new ImageLayer({
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
const observationLayer = new ImageLayer({
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


const radarSiteLayer = new VectorLayer({
	source: new Vector({
		format: new GeoJSON(),
		url: 'radars-finland.json',
	}),
	style: function(feature) {
		radarStyle.getText().setText(feature.get('name'));
    return radarStyle;
  }
});

const icaoLayer = new VectorLayer({
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

const guideLayer = new VectorLayer({
	source: new Vector(),
	style: rangeStyle,
/* 	style: function(feature) {
		rangeStyle.getText().setText(feature.get('name'));
    return rangeStyle;
  } */
});

const ownPositionLayer = new VectorLayer({
	visible: false,
	source: new Vector({
		features: [accuracyFeature, positionFeature]
	})
});


const layerss = {
	"satelliteLayer": satelliteLayer,
	"radarLayer": radarLayer,
	"observationLayer": observationLayer,
	"lightningLayer": lightningLayer
}

const layers = [
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
		let distance = getDistance(coordinate, ownPosition4326);
		let p1 = new LatLon(ownPosition4326[1], ownPosition4326[0]);
		let p2 = new LatLon(coordinate[1], coordinate[0]);
		let bearing = p1.initialBearingTo(p2);
		document.getElementById("cursorDistanceValue").innerHTML = distanceToString(distance) + '<br>' + bearing.toFixed(0) + "&deg;";
	}
	return Dms.toLat(coordinate[1], "dm", 3) + " " + Dms.toLon(coordinate[0], "dm", 3);
}

const mousePositionControl = new MousePosition({
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
	let c = new LatLon(coordinates[1], coordinates[0]);
	let p1 = c.destinationPoint(50000, direction);
	let p2 = c.destinationPoint(range * 1000, direction);
	let line = new Polygon([[[p1.lon, p1.lat], [p2.lon, p2.lat]]]);
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
	let coordinates = event.target.getPosition();
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
	let resolution = 300000;
	let end = Math.floor(Date.now() / resolution) * resolution - resolution;
  let start = end - resolution * 12;

	
	for (let item of VISIBLE) {
		let wmslayer = layerss[item].getSource().getParams().LAYERS;
		if (wmslayer in layerInfo) {
			if (item === "radarLayer" || item === "satelliteLayer" || item === "observationLayer") {
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
		
		if (startDate.getTime() === end && animationId === null) {
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

const play = function () {
	if (animationId === null) {
		debug("PLAY");
		IS_FOLLOWING = false;
		animationId = window.setInterval(setTime, 1000 / options.frameRate);
		document.getElementById("playstopButton").innerHTML = "pause";
	}
};

const stop = function () {
	if (animationId !== null) {
		debug("STOP");
		IS_FOLLOWING = false;
		window.clearInterval(animationId);
		animationId = null;
		document.getElementById("playstopButton").innerHTML = "play_arrow";
	}
};

const skipNext = function () {
	debug("NEXT");
	IS_FOLLOWING = false;
	stop();
	setTime('next');
}

const skipPrevious = function () {
	debug("PREVIOUS");
	IS_FOLLOWING = false;
	stop();
	setTime('previous');
}

const playstop = function () {
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
			IS_DARK = false;
			setButtonState("mapLayerButton", false);
			typeof umami !== 'undefined' && umami.track('theme-light');
			break;
		case 'dark':
			darkGrayBaseLayer.setVisible(true);
			darkGrayReferenceLayer.setVisible(true);
			lightGrayBaseLayer.setVisible(false);
			lightGrayReferenceLayer.setVisible(false);
			IS_DARK = true;
			setButtonState("mapLayerButton", true);
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
	let els = document.querySelectorAll(selector);
	els.forEach(function (elem) {
		elem.classList.remove('selected');
	});
}

function updateLayer(layer, wmslayer) {
	debug("Activated layer " + wmslayer);
	typeof umami !== 'undefined' && umami.track('layer-switch', { layer: wmslayer, category: layer.get('name') });
	debug(layerInfo[wmslayer]);
	let info = layerInfo[wmslayer];
	layer.set('info', info);
	if (document.getElementById(wmslayer)) {
		removeSelectedParameter("#" + layer.get("name") + " > div");
		document.getElementById(wmslayer).classList.add("selected");
	}
	if (info && info.url) {
		layer.setLayerUrl(info.url);
	}
	// Reset style if the new layer doesn't support the currently active style
	const currentStyle = layer.getSource().getParams().STYLES || '';
	if (currentStyle && info && info.style) {
		const validStyles = info.style.map(s => s.Name);
		if (!validStyles.includes(currentStyle)) {
			layer.getSource().updateParams({ 'LAYERS': wmslayer, 'STYLES': '' });
		} else {
			layer.getSource().updateParams({ 'LAYERS': wmslayer });
		}
	} else if (currentStyle) {
		// No style info available for new layer, reset to default
		layer.getSource().updateParams({ 'LAYERS': wmslayer, 'STYLES': '' });
	} else {
		layer.getSource().updateParams({ 'LAYERS': wmslayer });
	}
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



const highlightStyle = new Style({
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

const featureOverlay = new VectorLayer({
	source: new Vector(),
	map: map,
	style: function (feature) {
		return style;
	}
});
let highlight;

const displayFeatureInfo = function (pixel) {
	let feature = map.forEachFeatureAtPixel(pixel, function (feature) {
		return feature;
	});

	if (feature !== highlight) {
		if (highlight) {
			featureOverlay.getSource().removeFeature(highlight);
			guideLayer.getSource().clear(true);
		}
		if (feature && feature.getGeometry().getType() === 'Point') {
			featureOverlay.getSource().addFeature(feature);
			let coords = transform(feature.getGeometry().getCoordinates(), map.getView().getProjection(), 'EPSG:4326');
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
  let i = element.childNodes.length;
  while(i--){
    element.removeChild(element.lastChild);
  }
}

function layerInfoDiv(wmslayer) {
	let info = layerInfo[wmslayer];
	let div = document.createElement('div');
	let resolution = info && info.time ? Math.round(info.time.resolution/60000) : 0;

	div.id = wmslayer + 'Meta';
	div.setAttribute('data-layer-name', wmslayer);
	div.setAttribute('data-layer-category', info ? info.category : '');

	div.appendChild(createLayerInfoElement(info ? info.title : '', 'title'));

	let previewDiv = document.createElement('div');
	previewDiv.classList.add('preview');
	if (info && info.url && info.layer) {
		let img = document.createElement('img');
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
		let attrText = info.attribution.Title;
		if (info.license) attrText += ' (' + info.license + ')';
		div.appendChild(createLayerInfoElement(attrText,'attribution'));
	} else {
		div.appendChild(createLayerInfoElement('','attribution'));
	}
	return div;
}

const _playlistSliderHandlers = {};

function layerInfoPlaylist(event) {
	const layer = event.target;
	const name = layer.get('name')
	const info = layer.get('info')
	let opacity = layer.get('opacity') * 100

	if (typeof info === "undefined") return

	// If only opacity changed, update slider value without full DOM rebuild
	if (event.key === 'opacity') {
		let existingSlider = document.getElementById(name + 'Slider');
		if (existingSlider) {
			existingSlider.value = opacity;
			existingSlider.style.background = 'linear-gradient(to right, var(--dark-primary-color) ' + opacity + '%, var(--dark-theme-overlay-06dp) ' + opacity + '%)';
			let valEl = document.getElementById(name + 'OpacityValue');
			if (valEl) valEl.textContent = Math.round(opacity) + '%';
		}
		return;
	}

	// Always update text content and visibility state (cheap DOM updates)
	document.getElementById(name + 'Title').textContent = info.title || "";
	document.getElementById(name + 'Abstract').textContent = info.abstract || "";
	let attributionText = (info.attribution && info.attribution.Title) || "";
	if (info.license) {
		attributionText += (attributionText ? ' (' + info.license + ')' : info.license);
	}
	document.getElementById(name + 'Attribution').textContent = attributionText;
	if (layer.getVisible()) {
		document.getElementById(name + 'Info').classList.remove("playListDisabled");
		let ti = document.querySelector('#' + name + 'Info .card-visibility-toggle .material-icons');
		if (ti) ti.textContent = 'visibility';
	} else {
		document.getElementById(name + 'Info').classList.add("playListDisabled");
		let ti = document.querySelector('#' + name + 'Info .card-visibility-toggle .material-icons');
		if (ti) ti.textContent = 'visibility_off';
	}

	// Only do full DOM rebuild (slider, style chips) when playlist is visible
	let playList = document.getElementById('playList');
	if (!playList.classList.contains('open')) {
		return;
	}

	debug("Updating playlist for " + name);

	const activeStyleParam = layer.getSource().getParams().STYLES || '';
	if (typeof info.style !== "undefined") {
		if (info.style.length > 1) {
			// If no explicit style set, first style is the WMS default
			const activeStyleName = activeStyleParam || (info.style[0] && info.style[0].Name) || '';
			const parent = document.getElementById(name + 'Styles');
			while (parent.firstChild) parent.removeChild(parent.firstChild);
			info.style.forEach(style => {
				let div = document.createElement("div");
				div.textContent = style.Title;
				div.id = style.Name;
				if (style.Name === activeStyleName) {
					div.classList.add('activeStyle');
				}
				div.addEventListener('mouseup', function () {
					layer.setLayerStyle(style.Name);
					// Update active chip immediately
					parent.querySelectorAll('.activeStyle').forEach(function(el) { el.classList.remove('activeStyle'); });
					div.classList.add('activeStyle');
				});
				parent.appendChild(div);
			});
		} else {
			document.getElementById(name + 'Styles').textContent = "";
		}
	} else {
		document.getElementById(name + 'Styles').textContent = "";
	}

	// Build opacity control with label row + slider
	let opacityContainer = document.getElementById(name + 'Opacity');
	opacityContainer.textContent = '';

	let labelRow = document.createElement('div');
	labelRow.className = 'opacity-label-row';

	let label = document.createElement('label');
	label.setAttribute('for', name + 'Slider');
	label.className = 'opacity-label';
	label.textContent = 'Läpikuultavuus';

	let valueSpan = document.createElement('span');
	valueSpan.className = 'opacity-value';
	valueSpan.id = name + 'OpacityValue';
	valueSpan.textContent = Math.round(opacity) + '%';

	labelRow.appendChild(label);
	labelRow.appendChild(valueSpan);

	let slider = document.createElement('input');
	slider.type = 'range';
	slider.min = '1';
	slider.max = '100';
	slider.value = opacity;
	slider.className = 'slider';
	slider.id = name + 'Slider';
	slider.style.background = 'linear-gradient(to right, var(--dark-primary-color) ' + opacity + '%, var(--dark-theme-overlay-06dp) ' + opacity + '%)';

	opacityContainer.appendChild(labelRow);
	opacityContainer.appendChild(slider);

	// Remove previous slider listener to prevent leaks
	const oldSlider = document.getElementById(name + 'Slider');
	if (oldSlider && _playlistSliderHandlers[name]) {
		oldSlider.removeEventListener('input', _playlistSliderHandlers[name]);
	}
	_playlistSliderHandlers[name] = function (e) {
		const val = e.target.value;
		layer.setOpacity(val / 100);
		let valEl = document.getElementById(name + 'OpacityValue');
		if (valEl) valEl.textContent = Math.round(val) + '%';
		e.target.style.background = 'linear-gradient(to right, var(--dark-primary-color) ' + val + '%, var(--dark-theme-overlay-06dp) ' + val + '%)';
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
	typeof umami !== 'undefined' && umami.track('layer-visibility', { layer: wmslayer, category: name, visible: isVisible });
	if (isVisible) {
		debug("Activated " + name);
		VISIBLE.add(name);
		localStorage.setItem("VISIBLE",JSON.stringify([...VISIBLE]));
		if (document.getElementById(wmslayer)) {
			document.getElementById(wmslayer).classList.add("selected");
		}
		setButtonState(name+"Button", true);
		document.getElementById(name+'Info').classList.remove("playListDisabled");
		let toggleIcon = document.querySelector('#' + name + 'Info .card-visibility-toggle .material-icons');
		if (toggleIcon) toggleIcon.textContent = 'visibility';
	} else {
		debug("Deactivated " + name);
		VISIBLE.delete(name);
		localStorage.setItem("VISIBLE",JSON.stringify([...VISIBLE]));
		document.getElementById(name+"Off").classList.add("selected");
		setButtonState(name+"Button", false);
		document.getElementById(name+'Info').classList.add("playListDisabled");
		let toggleIcon = document.querySelector('#' + name + 'Info .card-visibility-toggle .material-icons');
		if (toggleIcon) toggleIcon.textContent = 'visibility_off';
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
	skipNext();
});

document.getElementById('skipPreviousButton').addEventListener('mouseup', function() {
	skipPrevious();
});

function openPlaylist() {
	document.getElementById("playList").classList.add('open');
	document.getElementById("playListBackdrop").classList.add('open');
	// Force full rebuild of all layer cards (slider, style chips)
	[satelliteLayer, radarLayer, lightningLayer, observationLayer].forEach(function(layer) {
		layerInfoPlaylist({ target: layer, key: 'info' });
	});
}

function closePlaylist() {
	document.getElementById("playList").classList.remove('open');
	document.getElementById("playListBackdrop").classList.remove('open');
}

function togglePlaylist() {
	debug("playlist");
	if (document.getElementById("playList").classList.contains('open')) {
		closePlaylist();
	} else {
		openPlaylist();
	}
}

document.getElementById('playlistButton').addEventListener('mouseup', togglePlaylist);

document.getElementById('playlistCloseButton').addEventListener('mouseup', closePlaylist);

document.getElementById('playListBackdrop').addEventListener('mouseup', closePlaylist);

// Visibility toggle buttons inside layer cards
document.querySelectorAll('.card-visibility-toggle').forEach(function(toggle) {
	toggle.addEventListener('mouseup', function(e) {
		const layerName = toggle.getAttribute('data-layer');
		const layerObj = layerss[layerName];
		if (layerObj) toggleLayerVisibility(layerObj);
		e.stopPropagation();
	});
});

// Close playlist if clicked outside of playlist
window.addEventListener('mouseup', function (e) {
	// playlist
	if (!document.getElementById('playList').contains(e.target)) {
		if (document.getElementById('playlistButton').contains(e.target)) return
		closePlaylist();
	}

	// Layers
	if (!document.getElementById('layers').contains(e.target)) {
		if (document.getElementById('layersButton').contains(e.target)) return
		let elem = document.getElementById("layers");
		//if (elem.style.display === 'block') {
			elem.style.display = 'none';
		//} 
	}

	// Close long-press menus when clicking/touching outside
	let longPressMenus = [
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
	let longPressMenus = [
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

function setButtonState(id, active) {
	const el = document.getElementById(id);
	el.classList.toggle("selectedButton", active);
	el.setAttribute("aria-pressed", String(active));
}

function setButtonStates() {
	setButtonState("locationLayerButton", IS_TRACKING);
	setButtonState("mapLayerButton", IS_DARK);
	setButtonState("satelliteLayerButton", VISIBLE.has("satelliteLayer"));
	setButtonState("radarLayerButton", VISIBLE.has("radarLayer"));
	setButtonState("lightningLayerButton", VISIBLE.has("lightningLayer"));
	setButtonState("observationLayerButton", VISIBLE.has("observationLayer"));
}

// Press feedback for all navbar buttons
document.querySelectorAll('.navbar > button').forEach(function(btn) {
	function addPress() { btn.classList.add('pressing'); }
	function removePress() { btn.classList.remove('pressing'); }
	btn.addEventListener('mousedown', addPress);
	btn.addEventListener('mouseup', removePress);
	btn.addEventListener('mouseleave', removePress);
	btn.addEventListener('touchstart', addPress);
	btn.addEventListener('touchend', removePress);
	btn.addEventListener('touchcancel', removePress);
});

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

// Long press menus for layer buttons
const observationMenu = createLongPressHandler('observationLayerButton', 'observationLongPressMenu',
	function() { toggleLayerVisibility(observationLayer); },
	function(id) { updateLayer(observationLayer, id); observationMenu.hide(); },
	function() { return observationLayer.getSource().getParams().LAYERS; },
	function() { return observationLayer.getVisible(); }
);

const satelliteMenu = createLongPressHandler('satelliteLayerButton', 'satelliteLongPressMenu',
	function() { toggleLayerVisibility(satelliteLayer); },
	function(id) { updateLayer(satelliteLayer, id); satelliteMenu.hide(); },
	function() { return satelliteLayer.getSource().getParams().LAYERS; },
	function() { return satelliteLayer.getVisible(); }
);

const radarMenu = createLongPressHandler('radarLayerButton', 'radarLongPressMenu',
	function() { toggleLayerVisibility(radarLayer); },
	function(id) { updateLayer(radarLayer, id); radarMenu.hide(); },
	function() { return radarLayer.getSource().getParams().LAYERS; },
	function() { return radarLayer.getVisible(); }
);

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

	let key = event.key || event.keyCode;
	let handled = true;
	if (key === ' ' || key === 'Space' || key === 32) {
		skipNext();
	} else if (key === ',' || key === 'Comma') {
		skipPrevious();
	} else if (key === '.' || key === 'Period') {
		skipNext();
	} else if (key === 'j' || key === 'KeyJ') {
		skipPrevious();
	} else if (key === 'k' || key === 'KeyK') {
		playstop();
	} else if (key === 'l' || key === 'KeyL') {
		skipNext();
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
		handled = false;
		debug(event);
	}

	if (handled) {
		event.preventDefault();
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

function getWMSCapabilities(wms, failCount) {
	failCount = failCount || 0;
	const parser = new WMSCapabilities();
	const namespace = wms.namespace ? '&namespace=' + wms.namespace : '';
	const layer = wms.layer ? '&layer=' + wms.layer : '';
	const controller = new AbortController();
	const timeoutId = setTimeout(function () { controller.abort(); }, 30000);
	debug('Request WMS Capabilities ' + wms.url);

	fetch(wms.url + '?SERVICE=WMS&version=1.3.0&request=GetCapabilities' + namespace + layer, {
		signal: controller.signal
	}).then(function (response) {
		return response.text();
	}).then(function (text) {
		clearTimeout(timeoutId);
		debug('Received WMS Capabilities ' + wms.url);
		failCount = 0;
		const result = parser.read(text);
		if (result && result.Capability && result.Capability.Layer && result.Capability.Layer.Layer) {
			getLayers(result.Capability.Layer.Layer, wms);
			debug(layerInfo);
			satelliteLayer.set('info', layerInfo[satelliteLayer.getSource().getParams().LAYERS]);
			radarLayer.set('info', layerInfo[radarLayer.getSource().getParams().LAYERS]);
			lightningLayer.set('info', layerInfo[lightningLayer.getSource().getParams().LAYERS]);
			observationLayer.set('info', layerInfo[observationLayer.getSource().getParams().LAYERS]);
			switch (wms.category) {
				case 'satelliteLayer':
					updateLayerSelection(satelliteLayer, 'satellite', 'msg_');
					break;
				case 'observationLayer':
					updateLayerSelection(observationLayer, 'observation', 'observation:');
					break;
				case 'radarLayer':
					updateLayerSelection(radarLayer, 'radar', 'suomi_');
					break;
				case 'lightningLayer':
					updateLayerSelection(lightningLayer, 'lightning', 'lightning');
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
		clearTimeout(timeoutId);
		failCount++;
		debug('Error fetching WMS Capabilities from ' + wms.url + ': ' + error.message + ' (fail #' + failCount + ')');
	}).finally(function () {
		// Exponential backoff on failure: refresh, 2x, 4x, max 5 min
		const delay = failCount > 0
			? Math.min(wms.refresh * Math.pow(2, failCount), 300000)
			: wms.refresh;
		setTimeout(function () { getWMSCapabilities(wms, failCount); }, delay);
	});
}

function getLayers(parentlayer,wms) {
	let products = {}
	parentlayer.forEach((layer) => {
		if (Array.isArray(layer.Layer)) {
			getLayers(layer.Layer,wms)
		} else {
			let name = layer.Name;
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

	if (typeof wms.license !== "undefined") {
		product.license = wms.license;
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
	let beginTime
	let endTime
	let resolutionTime
	let prevtime
	let defaultTime

	dimensions.forEach((dimension) => {
		if (dimension.name === 'time') {
			defaultTime = dimension.default ? dayjs(dimension.default).valueOf() : NaN
			dimension.values.split(",").forEach((times) => {
				let time = times.split("/")
				// Time dimension is list of times separated by comma
				if (time.length === 1) {
					//var timeValue = dayjs(time[0]).valueOf()
					let timeValue = dayjs(new Date(time[0])).valueOf()
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
				else if (time.length === 3) {
					beginTime = dayjs(time[0]).valueOf()
					endTime = dayjs(time[1]).valueOf()
					resolutionTime = dayjs.duration(time[2]).asMilliseconds()
				}
			}) // forEach
		} // if
	}) // forEach
	let currentTime = new Date().getTime()
	let type = endTime > currentTime ? "for" : "obs"
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