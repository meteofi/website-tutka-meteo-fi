import {Map, View} from 'ol';
import {FullScreen, MousePosition} from 'ol/control.js';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
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
import { connect } from 'mqtt';

var options = {
	defaultRadarLayer: "MeteoFI:radar_finland_dbz",
	rangeRingSpacing: 50,
	radialSpacing: 30,
	frameRate: 4, // fps
	wmsServer: {
		'meteo': "https://wms.meteo.fi/geoserver/wms", // "MeteoFI:radar_finland_dbz"
		'fmi': "https://openwms.fmi.fi/geoserver/wms", //"Radar:suomi_dbz_eureffin"
		'dwd': "https://maps.dwd.de/geoserver/wms", // "dwd:RX-Produkt"
		'knmi': "https://geoservices.knmi.nl/cgi-bin/RADNL_OPER_R___25PCPRR_L3.cgi", // "RADNL_OPER_R___25PCPRR_L3_COLOR"
		"nws": "https://idpgis.ncep.noaa.gov/arcgis/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer", // "0"
		"eumetsat": "https://eumetview.eumetsat.int/geoserv/meteosat/wms", // "meteosat:msg_eview"
	}
}

var DEBUG = true;
var metLatitude  = localStorage.getItem("metLatitude")  ? localStorage.getItem("metLatitude")  : 60.2706;
var metLongitude = localStorage.getItem("metLongitude") ? localStorage.getItem("metLongitude") : 24.8725;
var metRadarLayer = localStorage.getItem("metRadarLayer") ? localStorage.getItem("metRadarLayer") : "MeteoFI:radar_finland_dbz";
var ownPosition = [];
var startDate = new Date(Math.floor(Date.now() / 300000) * 300000 - 300000 * 12);
var animationId = null;
var moment = require('moment');
moment.locale('fi');
var layerInfo = {};
const client  = connect('wss://meri.digitraffic.fi:61619/mqtt',{username: 'digitraffic', password: 'digitrafficPassword'});
var WMSURL = options.wmsServer.meteo;
var trackedVessels = {'230059770': {}, '230994270': {}, '230939100': {}, '230051170': {}, '230059740': {}, '230108850': {}, '230937480': {}, '230051160': {}, '230983250': {}, '230012240': {}, '230980890': {}, '230061400': {}, '230059760': {}, '230005610': {}, '230987580': {}, '230983340': {}, '230111580': {}, '230059750': {}, '230994810': {}, '230993590': {}, '230051150': {} };
var activeLayers =  new Set();
activeLayers.add("radarLayer");

function debug(str) {
	if (DEBUG) {
		try {
			console.log(str);
		} catch (e) { };
	}
}

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

var vesselStyle = new Style({
	image: new CircleStyle({
		radius: 5,
		fill: null,
		stroke: new Stroke({ color: 'red', width: 2 })
	}),
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
	})
});

//
// LAYERS
//
var lightGrayBaseLayer = new TileLayer({
	visible: false,
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
	visible: false,
	opacity: 0.7,
	source: new ImageWMS({
		url: options.wmsServer.eumetsat,
		params: { 'LAYERS': "msg_eview" },
		ratio: 1,
		serverType: 'geoserver'
	})
});

// Radar Layer
var radarLayer = new ImageLayer({
	name: "radarLayer",
	opacity: 0.7,
	source: new ImageWMS({
		url: WMSURL,
		params: { 'LAYERS': metRadarLayer },
		ratio: 1,
		serverType: 'geoserver'
	})
});

// Lightning Layer
var lightningLayer = new ImageLayer({
	name: "lightningLayer",
	visible: false,
	source: new ImageWMS({
		url: WMSURL,
		params: { 'LAYERS': 'observation:lightning' },
		ratio: 1,
		serverType: 'geoserver'
	})
});

// Observation Layer
var observationLayer = new ImageLayer({
	name: "observationLayer",
	visible: false,
	source: new ImageWMS({
		url: WMSURL,
		params: { 'LAYERS': 'observation:air_temperature' },
		ratio: 1,
		serverType: 'geoserver'
	})
});


var positionLayer = new VectorLayer({
	source: new Vector({
		format: new GeoJSON(),
		url: 'radars-finland.json'
	}),
	//,
	//style: function(feature) {
	//	style.getText().setText(feature.get('mmsi'));
	//	return style;
	//}
});

var smpsLayer = new VectorLayer({
	source: new Vector(),
	visible: false,
	style: function (feature) {
		vesselStyle.getText().setText(getVesselName(feature.get('mmsi')) + " " + feature.get('sog') + "kn");
		return vesselStyle;
	}
});

var guideLayer = new VectorLayer({
	source: new Vector(),
	style: rangeStyle
});

var ownPositionLayer = new VectorLayer({
	source: new Vector(),
	style: ownStyle,
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
	satelliteLayer,
	radarLayer,
	guideLayer,
	lightningLayer,
	lightGrayReferenceLayer,
	darkGrayReferenceLayer,
	observationLayer,
  positionLayer,
	ownPositionLayer,
	smpsLayer
];

function mouseCoordinateFormat (coordinate) {
	var distance = getDistance(coordinate,ownPosition);
	var distance_km = distance/1000;
	var distance_nm = distance/1852;
	document.getElementById("cursorDistanceValueKM").innerHTML = distance_km.toFixed(3) + " km";
	document.getElementById("cursorDistanceValueNM").innerHTML = distance_nm.toFixed(3) + " NM";
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
		//		new FullScreen(), mousePositionControl
	],
  view: new View({
		enableRotation: false,
    center: fromLonLat([26, 65]),
    zoom: 5
	}),
	keyboardEventTarget: document
});

sync(map);


function rangeRings (layer, coordinates, range) {
	const ring = circular(coordinates, range);
	layer.getSource().addFeatures([
		new Feature(ring.transform('EPSG:4326', map.getView().getProjection()))
	]);	
}

function bearingLine(layer, coordinates, range, direction) {
	var c = new LatLon(coordinates[1], coordinates[0]);
	var p1 = c.destinationPoint(50000, direction);
	var p2 = c.destinationPoint(range * 1000, direction);
	var line = new Polygon([[[p1.lon, p1.lat], [p2.lon, p2.lat]]]);
	layer.getSource().addFeatures([
		new Feature(line.transform('EPSG:4326', map.getView().getProjection()))
	]);
}

navigator.geolocation.watchPosition(function(pos) {
	const coords = [pos.coords.longitude, pos.coords.latitude];
	ownPosition = coords;
	const accuracy = circular(coords, pos.coords.accuracy);
	document.getElementById("positionLatValue").innerHTML = "&#966; " + Dms.toLat(pos.coords.latitude, "dm", 3);
	document.getElementById("positionLonValue").innerHTML = "&#955; " + Dms.toLon(pos.coords.longitude, "dm", 3);
	//document.getElementById("infoItemPosition").style.display = "block";
	document.getElementById("cursorDistanceTxtKM").style.display = "block";
	document.getElementById("cursorDistanceTxtNM").style.display = "block";
  ownPositionLayer.getSource().clear(true);
  ownPositionLayer.getSource().addFeatures([
    new Feature(accuracy.transform('EPSG:4326', map.getView().getProjection())),
    new Feature(new Point(fromLonLat(coords)))
  ]);
}, function(error) {
  debug(`ERROR: ${error.message}`);
}, {
  enableHighAccuracy: true
});



function setLayerTime(layer, time) {
	layer.getSource().updateParams({ 'TIME': time });
	if (moment(time).isValid()) {
		document.getElementById("radarDateValue").innerHTML = moment(time).format('l');
		document.getElementById("radarTimeValue").innerHTML = moment(time).format('LT');
		document.getElementById("currentMapTime").innerHTML = moment(time).format('LT');
	}
}

function setLayerStyle(layer, style) {
	layer.getSource().updateParams({ 'STYLES': style });
}

function setTime(reverse=false) {
	var resolution = 300000;
	var end = Math.floor(Date.now() / resolution) * resolution - resolution;
  var start = end - resolution * 12;

	if (typeof (layerInfo[radarLayer.getSource().getParams().LAYERS]) !== "undefined") {
		for (let item of activeLayers) {
			var wmslayer = layerss[item].getSource().getParams().LAYERS
			resolution = Math.max(resolution, layerInfo[wmslayer].time.resolution)
			if (item == "radarLayer" || item == "satelliteLayer") {
				end = Math.min(end, Math.floor(layerInfo[wmslayer].time.end / resolution) * resolution);
			}
			start = Math.floor(end / resolution) * resolution - resolution * 12;
		}
		
		if (reverse) {
			startDate.setMinutes(startDate.getMinutes() - resolution / 60000);
		} else {
			startDate.setMinutes(startDate.getMinutes() + resolution / 60000);
		}

		if (startDate.getTime() > end) {
			startDate = new Date(start);
		} else if (startDate.getTime() < start) {
			startDate = new Date(end);
		}

		setLayerTime(satelliteLayer, startDate.toISOString());
		setLayerTime(radarLayer, startDate.toISOString());
		setLayerTime(lightningLayer, 'PT'+(resolution/60000)+'M/' + startDate.toISOString());
		setLayerTime(observationLayer, startDate.toISOString());
	} 
}

function updateClock() {
	var lt = moment();
	var utc = moment.utc();

	// set the content of the element with the ID time to the formatted string
	document.getElementById("currentDateValue").innerHTML = lt.format('l');
	document.getElementById("currentLocalTimeValue").innerHTML = lt.format('LTS') + ' LT';
	document.getElementById("currentUTCTimeValue").innerHTML = utc.format('LTS') + " UTC";

	// call this function again in 1000ms
	setTimeout(updateClock, 1000);
}

var play = function () {
	if (animationId === null) {
		debug("PLAY");
		animationId = window.setInterval(setTime, 1000 / options.frameRate);
		document.getElementById("playstop").innerHTML = "pause";
		document.getElementById("playstopButton").innerHTML = "pause";
	}
};

var stop = function () {
	if (animationId !== null) {
		debug("STOP");
		window.clearInterval(animationId);
		animationId = null;
		document.getElementById("playstop").innerHTML = "play_arrow";
		document.getElementById("playstopButton").innerHTML = "play_arrow";
	}
};

var skip_next = function () {
	debug("NEXT");
	stop();
	setTime();
}

var skip_previous = function () {
	debug("PREVIOUS");
	stop();
	setTime(true);
}

var playstop = function () {
	if (animationId !== null) {
		stop();
	} else {
		play();
	}
};

// Start Animation
//document.getElementById("infoItemPosition").style.display = "none";
document.getElementById("cursorDistanceTxtKM").style.display = "none";
document.getElementById("cursorDistanceTxtNM").style.display = "none";

updateClock();
readWMSCapabilities(options.wmsServer.meteo,60000);
readWMSCapabilities(options.wmsServer.eumetsat,300000);

Object.keys(trackedVessels).forEach(function (item) {
	debug("Subscribed vessel " + item + " locations");
	client.subscribe("vessels/" + item + "/+");
});

function getVesselName(mmsi) {
	if (typeof trackedVessels[mmsi].metadata !== "undefined") {
			return trackedVessels[mmsi].metadata.name;
	} else {
		return mmsi;
	}
}

client.on("message", function (topic, payload) {
	var vessel = {};
	var metadata = {};
	if (topic.indexOf('location') !== -1) {
		vessel = JSON.parse(payload.toString());
	}	
	debug(topic);
	if (topic.indexOf('metadata') !== -1) {
		metadata = JSON.parse(payload.toString());
		trackedVessels[metadata.mmsi].metadata = metadata;
		return;
	}	
	var format = new GeoJSON({
		dataProjection: 'EPSG:4326',
		featureProjection: "EPSG:3857"
	});
	trackedVessels[vessel.mmsi].location = vessel;
	trackedVessels[vessel.mmsi].location.properties.mmsi = vessel.mmsi;
	smpsLayer.getSource().clear(true);
	Object.keys(trackedVessels).forEach(function (item) {
		if (typeof trackedVessels[item].location !== "undefined") {
			smpsLayer.getSource().addFeature(format.readFeature(trackedVessels[item].location));
		}
	});
	//client.end()
});

	play();

document.getElementById('darkBase').addEventListener('click', function (event) {
	debug("darkBase")
	event.target.classList.add("selected");
	document.getElementById("lightBase").classList.remove("selected");
	darkGrayBaseLayer.setVisible(true);
	darkGrayReferenceLayer.setVisible(true);
	lightGrayBaseLayer.setVisible(false);
	lightGrayReferenceLayer.setVisible(false);
});

document.getElementById('lightBase').addEventListener('click', function (event) {
	debug("lightBase")
	event.target.classList.add("selected");
	document.getElementById("darkBase").classList.remove("selected");
	darkGrayBaseLayer.setVisible(false);
	darkGrayReferenceLayer.setVisible(false);
	lightGrayBaseLayer.setVisible(true);
	lightGrayReferenceLayer.setVisible(true);
});

function removeSelectedParameter (selector) {
	var els = document.querySelectorAll(selector);
	els.forEach(function(elem) {
    elem.classList.remove('selected');
	});
}


function updateLayer(layer, wmslayer) {
	debug("Activated layer " + wmslayer);
	debug(layerInfo[wmslayer]);
	removeSelectedParameter("#" + layer.get("name") + " > div");
	document.getElementById(wmslayer).classList.add("selected");
	document.getElementById(layer.get("name")+"Button").classList.add("selectedButton");
	activeLayers.add(layer.get("name"));
	layer.getSource().updateParams({ 'LAYERS': wmslayer });
	layer.setVisible(true);
}

function addEventListeners(selector) {
	let elementsArray = document.querySelectorAll(selector);
	elementsArray.forEach(function (elem) {
		debug("Activated event listener for " + elem.id);
		elem.addEventListener("click", function () {
			if (event.target.id.indexOf("Off") !== -1) {
				removeSelectedParameter("#" + event.target.parentElement.id + " > div");
				document.getElementById(event.target.parentElement.id+"Button").classList.remove('selectedButton');
				event.target.classList.add("selected");
				debug("Deactivated layer " + event.target.parentElement.id);
				layerss[event.target.parentElement.id].setVisible(false);
				activeLayers.delete(event.target.parentElement.id);
			} else {
				updateLayer(layerss[event.target.parentElement.id], event.target.id);
			}
		});
	});
}

addEventListeners("#satelliteLayer > div");
addEventListeners("#radarLayer > div");
addEventListeners("#lightningLayer > div");
addEventListeners("#observationLayer > div");

    // Start Position Watch
 //   if ("geolocation" in navigator) {
//			var watchIdG  = navigator.geolocation.watchPosition(geoLocationUpdate,geoLocationFail,{enableHighAccuracy:true});
//			debug("Started geolocation watch position. ("+watchIdG+")");
//	} else {
//			debug("Geolocation is not supported by this browser.");
//	}

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
		style.getText().setText(feature.get('name'));
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
		if (feature) {
			featureOverlay.getSource().addFeature(feature);
			var coords = transform(feature.getGeometry().getCoordinates(), map.getView().getProjection(), 'EPSG:4326');
			[50000,100000,150000,200000,250000].forEach(range => rangeRings(guideLayer, coords, range));
			Array.from({length:360/options.radialSpacing},(x,index)=>index*options.radialSpacing).forEach(bearing => bearingLine(guideLayer, coords, 250, bearing));
			map.getView().fit(guideLayer.getSource().getExtent(), map.getSize()); 
		}
		highlight = feature;
	}

};

function toggleLayerVisibility(layer) {
	var visibility = layer.getVisible();
	removeSelectedParameter("#" + layer.get("name") + " > div");
	if (visibility == false) {
		layer.setVisible(true);
		activeLayers.add(layer.get("name"));
		document.getElementById(layer.getSource().getParams().LAYERS).classList.add("selected");
		document.getElementById(layer.get("name")+"Button").classList.add("selectedButton");
	}
	if (visibility == true) {
		layer.setVisible(false);
		activeLayers.delete(layer.get("name"));
		document.getElementById(layer.get("name")+"Off").classList.add("selected");
		document.getElementById(layer.get("name")+"Button").classList.remove("selectedButton");
	}
}

function geoLocationFail(error) {
	switch (error.code) {
		case error.PERMISSION_DENIED:
			debug("ERROR: User denied the request for geolocation.");
			break;
		case error.POSITION_UNAVAILABLE:
			debug("ERROR: Geolocation information is unavailable.");
			break;
		case error.TIMEOUT:
			debug("ERROR: The request to get user geolocation timed out.");
			break;
		case error.UNKNOWN_ERROR:
			debug("ERROR: An unknown error occurred.");
			break;
	}
}

function geoLocationUpdate(location) {
	localStorage.setItem("metLatitude", location.coords.latitude);
	localStorage.setItem("metLongitude", location.coords.longitude);
	metLatitude = location.coords.latitude;
	metLongitude = location.coords.longitude;
//	$('#positionTxt').html("&#966; " + Dms.toLat(metLatitude, "dm", 3) + "<br/>" + "&#955; " + Dms.toLon(metLongitude, "dm", 3));
//	$('#infoItemPosition').show();
}

//
// EVENTS
//

document.getElementById('playButton').addEventListener('click', function() {
	playstop();
});

document.getElementById('skipNextButton').addEventListener('click', function() {
	skip_next();
});

document.getElementById('skipPreviousButton').addEventListener('click', function() {
	skip_previous();
});

document.getElementById('playstop').addEventListener('click', function() {
	playstop();
});

document.getElementById('skip_next').addEventListener('click', function() {
	skip_next();
});

document.getElementById('skip_previous').addEventListener('click', function() {
	skip_previous();
});

document.getElementById('locationLayerButton').addEventListener('click', function() {
	map.getView().setCenter(fromLonLat(ownPosition));
});

document.getElementById('satelliteLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(satelliteLayer);
});

document.getElementById('radarLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(radarLayer);
});

document.getElementById('lightningLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(lightningLayer);
});

document.getElementById('observationLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(observationLayer);
});

map.on('click', function(evt) {
	displayFeatureInfo(evt.pixel);
});

document.addEventListener('keyup', function (event) {
	if (event.defaultPrevented) {
		return;
	}

	var key = event.key || event.keyCode;
	debug(event);
	if (key === ' ' || key === 'Space' || key === 32) {
		skip_next();
	} else if (key === 's' || key === 'KeyS' || key === 83) {
		toggleLayerVisibility(smpsLayer); 
	} else if (key === 'f' || key === 'KeyF') {
		setLayerStyle(radarLayer,"radar_finland_dbz_fmi"); 
	} else if (key === 'g' || key === 'KeyG') {
		setLayerStyle(radarLayer,""); 
	} else if (key === '1' || key === 'Digit1') {
		toggleLayerVisibility(satelliteLayer);
	} else if (key === '2' || key === 'Digit2') {
		toggleLayerVisibility(radarLayer);    
	} else if (key === '3' || key === 'Digit3') {
		toggleLayerVisibility(lightningLayer);    
	} else if (key === '4' || key === 'Digit4') {
		toggleLayerVisibility(observationLayer);    
	}

});

function readWMSCapabilities(url,timeout) {
	var parser = new WMSCapabilities();
	debug("Request WMS Capabilities " + url);
	fetch(url + '?SERVICE=WMS&version=1.3.0&request=GetCapabilities').then(function (response) {
		return response.text();
	}).then(function (text) {
		debug("Received WMS Capabilities " + url);
		var result = parser.read(text);
		getLayers(result.Capability.Layer.Layer);
		if (typeof (radarLayer.time) === "undefined") {
			radarLayer.time = layerInfo[metRadarLayer].time;
		}
	});
	setTimeout(function() {readWMSCapabilities(url,timeout)}, timeout);
}

function getLayers(parentlayer) {
	let products = {}
	parentlayer.forEach((layer) => {
		if (Array.isArray(layer.Layer)) {
			getLayers(layer.Layer)
		} else {
			layerInfo[layer.Name] = getLayerInfo(layer)
		}
	})
	return products;
}

function getLayerInfo(layer) {
	let product =
	{
		title: layer.Title,
		layer: layer.Name,
		abstract: layer.Abstract
	}
	if (typeof layer.Dimension !== "undefined") {
		product.time = getTimeDimension(layer.Dimension)
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
			defaultTime = dimension.default ? moment(dimension.default).valueOf() : NaN
			dimension.values.split(",").forEach((times) => {
				var time = times.split("/")
				// Time dimension is list of times separated by comma
				if (time.length == 1) {
					// begin time is the smallest of listed times
					beginTime = beginTime ? beginTime : moment(time[0]).valueOf()
					beginTime = Math.min(beginTime, moment(time[0]).valueOf())
					// end time is the bigest of listed times
					endTime = endTime ? endTime : moment(time[0]).valueOf()
					endTime = Math.max(endTime, moment(time[0]).valueOf())
					// resolution is the difference of the last two times listed
					resolutionTime = prevtime ? (moment(time[0]).valueOf() - prevtime) : 3600000
					prevtime = moment(time[0]).valueOf()
				}
				// Time dimension is starttime/endtime/period
				else if (time.length == 3) {
					beginTime = moment(time[0]).valueOf()
					endTime = moment(time[1]).valueOf()
					resolutionTime = moment.duration(time[2]).asMilliseconds()
				}
			}) // forEach
		} // if
	}) // forEach
	var currentTime = new Date().getTime()
	var type = endTime > currentTime ? "for" : "obs"
	//console.log("start: " + beginTime + " end: " + endTime + " resolution: " + resolutionTime + " type: " + type + " default: " + defaultTime)
	return { start: beginTime, end: endTime, resolution: resolutionTime, type: type, default: defaultTime }
}
