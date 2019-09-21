import {Map, View} from 'ol';
import {MousePosition} from 'ol/control.js';
import Geolocation from 'ol/Geolocation';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import TileWMS from 'ol/source/TileWMS';
import WMTS, {optionsFromCapabilities} from 'ol/source/WMTS.js';
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
import WMTSCapabilities from 'ol/format/WMTSCapabilities.js';
import { connect } from 'mqtt';
import { transformExtent } from 'ol/proj';
//import Worker from './wmscapabilities.worker.js'; 

var options = {
	defaultRadarLayer: 'radar_finland_dbz',
	defaultLightningLayer: 'lightning',
	rangeRingSpacing: 50,
	radialSpacing: 30,
	frameRate: 2, // fps
	defaultFrameRate: 2, // fps
	imageRatio: 1.5,
	wmsServer: {
		'meteo': {
			'radar': "https://wms.meteo.fi/geoserver/radar/wms",
			'observation': "https://wms.meteo.fi/geoserver/observation/wms",
			'test': "https://geoserver.apps.meteo.fi/geoserver/observation/wms"
		},
		'fmi': "https://openwms.fmi.fi/geoserver/Radar/wms", //"Radar:suomi_dbz_eureffin"
		'dwd': "https://maps.dwd.de/geoserver/wms", // "dwd:RX-Produkt"
		'knmi': "https://geoservices.knmi.nl/cgi-bin/RADNL_OPER_R___25PCPRR_L3.cgi", // "RADNL_OPER_R___25PCPRR_L3_COLOR"
		"nws": "https://idpgis.ncep.noaa.gov/arcgis/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer", // "0"
		"eumetsat": "https://eumetview.eumetsat.int/geoserv/meteosat/wms", // "meteosat:msg_eview"
		"s57": "https://julkinen.vayla.fi/s57/wms",
	}
}

var DEBUG = true;
var metLatitude = localStorage.getItem("metLatitude")
	? localStorage.getItem("metLatitude")
	: 60.2706;
var metLongitude = localStorage.getItem("metLongitude")
	? localStorage.getItem("metLongitude") 
	: 24.8725;
var ownPosition = [];
var ownPosition4326 = [];
var startDate = new Date(Math.floor(Date.now() / 300000) * 300000 - 300000 * 12);
var animationId = null;
var moment = require('moment');
moment.locale('fi');
var layerInfo = {};
const client  = connect('wss://meri.digitraffic.fi:61619/mqtt',{username: 'digitraffic', password: 'digitrafficPassword'});
var trackedVessels = {'230059770': {}, '230994270': {}, '230939100': {}, '230051170': {}, '230059740': {}, '230108850': {}, '230937480': {}, '230051160': {}, '230983250': {}, '230012240': {}, '230980890': {}, '230061400': {}, '230059760': {}, '230005610': {}, '230987580': {}, '230983340': {}, '230111580': {}, '230059750': {}, '230994810': {}, '230993590': {}, '230051150': {} };

document.ontouchmove = function(e){ 
	e.preventDefault(); 
}
// STATUS Variables
	var VISIBLE = localStorage.getItem("VISIBLE")
	? new Set(JSON.parse(localStorage.getItem("VISIBLE")))
	: new Set(["radarLayer"]);

	var IS_DARK = localStorage.getItem("IS_DARK")
	? JSON.parse(localStorage.getItem("IS_DARK"))
	: true;

	var IS_TRACKING = localStorage.getItem("IS_TRACKING")
	? JSON.parse(localStorage.getItem("IS_TRACKING"))
	: false;

	var IS_FOLLOWING = localStorage.getItem("IS_FOLLOWING")
	? JSON.parse(localStorage.getItem("IS_FOLLOWING"))
	: false;

	var IS_NAUTICAL = localStorage.getItem("IS_NAUTICAL")
	? JSON.parse(localStorage.getItem("IS_NAUTICAL"))
	: false;

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

var merikarttaLayer = new TileLayer();
var pohjakarttaLayer = new TileLayer();

// fetch('https://julkinen.vayla.fi/rasteripalvelu/wmts?request=getcapabilities').then(function (response) {
// 	return response.text();
// }).then(function (text) {
// 	var parser = new WMTSCapabilities();
// 	var result = parser.read(text);
// 	//debug(result);
// 	var options = optionsFromCapabilities(result, {
// 		layer: 'liikennevirasto:Merikarttasarjat public',
// 		matrixSet: 'WGS84_Pseudo-Mercator'
// 	});
// 	//debug("OPTIONS");
// 	//debug(options);
// 	merikarttaLayer.setSource(new WMTS(options));
// });


// fetch('https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts?service=WMTS&request=GetCapabilities&version=1.0.0').then(function (response) {
// 	return response.text();
// }).then(function (text) {
// 	var parser = new WMTSCapabilities();
// 	var result = parser.read(text);
// 	//debug(result);
// 	var options = optionsFromCapabilities(result, {
// 		layer: 'taustakartta',
// 		matrixSet: 'WGS84_Pseudo-Mercator'
// 	});
// 	//debug("OPTIONS");
// 	//debug(options);
// 	pohjakarttaLayer.setSource(new WMTS(options));
// });

// S-57 Layer
var s57Layer = new TileLayer({
	name: "navicationLayer",
	visible: true,
	opacity: 1,
	source: new TileWMS({
		url: options.wmsServer.s57,
		params: { 'LAYERS': "cells", 'TILED': true },
		hidpi: false,
		ratio: options.imageRatio,
		serverType: 'geoserver'
	})
});

// Satellite Layer
var satelliteLayer = new ImageLayer({
	name: "satelliteLayer",
	visible: VISIBLE.has("satelliteLayer"),
	opacity: 0.7,
	source: new ImageWMS({
		url: options.wmsServer.eumetsat,
		params: { 'FORMAT': 'image/jpeg', 'LAYERS': "msg_eview" },
		hidpi: false,
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
		url: options.wmsServer.meteo.radar,
		params: { 'LAYERS': options.defaultRadarLayer },
		attributions: 'FMI',
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
		url: options.wmsServer.meteo.test,
		params: { 'FORMAT': 'image/png8', 'LAYERS': options.defaultLightningLayer },
		ratio: options.imageRatio,
		serverType: 'geoserver'
	})
});

// Observation Layer
var observationLayer = new ImageLayer({
	name: "observationLayer",
	visible: VISIBLE.has("observationLayer"),
	source: new ImageWMS({
		url: options.wmsServer.meteo.test,
		params: { 'FORMAT': 'image/png8', 'LAYERS': 'air_temperature' },
		ratio: options.imageRatio,
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
//	s57Layer,
	satelliteLayer,
	radarLayer,
	guideLayer,
	lightningLayer,
	lightGrayReferenceLayer,
	darkGrayReferenceLayer,
  positionLayer,
	ownPositionLayer,
	observationLayer,
	smpsLayer
];

function distanceToString(distance) {
	var str;
	if (IS_NAUTICAL) {
		str = (distance / 1852).toFixed(3) + ' NM';
	} else {
		if (distance < 1000) {
			str = Math.round(distance) + ' m';
		} else {
			str = (distance / 1000).toFixed(1) + ' km';
		}
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
		//		new FullScreen(), mousePositionControl
	],
  view: new View({
		enableRotation: false,
    center: fromLonLat([26, 65]),
    zoom: 5
	}),
	keyboardEventTarget: document
});
map.getView().fit(transformExtent([19.24, 59.75, 31.59, 70.09],'EPSG:4326', map.getView().getProjection()));
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

// GEOLOCATION Functions

function onChangeAccuracyGeometry(event) {
	debug('Accuracy geometry changed.');
	accuracyFeature.setGeometry(event.target.getAccuracyGeometry());
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
//	if (IS_TRACKING) {
//		map.getView().setCenter(ownPosition);
//	}
};

// WMS 

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

function setLayerElevation(layer, elevation) {
	layer.getSource().updateParams({ 'ELEVATION': elevation });
}

//radarLayer.getSource().addEventListener('imageloadend', function (event) {
//	debug(event);
//});

// TIMELINE

function updateTimeLine (position) {
	let elementsArray = document.querySelectorAll('#timeline > div');
	elementsArray.forEach(function (elem) {
		if (elem.id.split("-")[2] <= position) {
			elem.classList.add("timeline-on");
			elem.classList.remove("timeline-off");
		} else {
			elem.classList.add("timeline-off");
			elem.classList.remove("timeline-on");
		}
	});
}

function createTimeline (count) {
	var i = 0;
	document.getElementById("timeline").innerHTML = "";
	for (i = 0; i < count; i++) { 
		var div = document.createElement("div");
		//div.innerHTML = i;
		div.id = "timeline-item-" + i;
		div.classList.add("timeline-off");
		document.getElementById("timeline").appendChild(div);
	}
}

function gtag() { 
	if (typeof dataLayer !== "undefined") {
		dataLayer.push(arguments); 
	}
}

function updateCanonicalPage() {
	var page = "";
	if (satelliteLayer.getVisible()) {
		var split = satelliteLayer.getSource().getParams().LAYERS.split(":"); 
		page = page + "/" + ((split.length > 1) ? split[1] : split[0])
	}
	if (radarLayer.getVisible()) {
		var split = radarLayer.getSource().getParams().LAYERS.split(":"); 
		page = page + "/" + ((split.length > 1) ? split[1] : split[0])
	}
	if (lightningLayer.getVisible()) {
		var split = lightningLayer.getSource().getParams().LAYERS.split(":"); 
		page = page + "/" + ((split.length > 1) ? split[1] : split[0])
	}
	if (observationLayer.getVisible()) {
		var split = observationLayer.getSource().getParams().LAYERS.split(":"); 
		page = page + "/" + ((split.length > 1) ? split[1] : split[0])
	}
	debug("Set page: " + page);
	gtag('config', 'UA-23910741-3', {'page_path': page});
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
			createTimeline(13);
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

		updateTimeLine((startDate.getTime()-start)/resolution);
		setLayerTime(satelliteLayer, startDate.toISOString());
		setLayerTime(radarLayer, startDate.toISOString());
		setLayerTime(lightningLayer, 'PT'+(resolution/60000)+'M/' + startDate.toISOString());
		setLayerTime(observationLayer, 'PT'+(resolution/60000)+'M/' + startDate.toISOString());

}

function updateClock() {
	var lt = moment();
	var utc = moment.utc();

	document.getElementById("currentDateValue").innerHTML = lt.format('l');
	document.getElementById("currentLocalTimeValue").innerHTML = lt.format('LTS');
	document.getElementById("currentUTCTimeValue").innerHTML = utc.format('LTS') + " UTC";

	// call this function again in 1000ms
	setTimeout(updateClock, 1000);
}

//
// TIME CONTROLS
//

var play = function () {
	if (animationId === null) {
		debug("PLAY");
		IS_FOLLOWING = false;
		animationId = window.setInterval(setTime, 1000 / options.frameRate);
		document.getElementById("playstop").innerHTML = "pause";
		document.getElementById("playstopButton").innerHTML = "pause";
	}
};

var stop = function () {
	if (animationId !== null) {
		debug("STOP");
		IS_FOLLOWING = false;
		window.clearInterval(animationId);
		animationId = null;
		document.getElementById("playstop").innerHTML = "play_arrow";
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
		gtag('event', 'stop', {'event_category' : 'timecontrol'});
	} else {
		play();
		gtag('event', 'play', {'event_category' : 'timecontrol'});
	}
};

// Start Animation
//document.getElementById("infoItemPosition").style.display = "none";
document.getElementById("cursorDistanceTxt").style.display = "none";



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
	//debug(topic);
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
			gtag('event', 'light', {'event_category' : 'mapcontrol'});
			break;
		case 'dark':
			darkGrayBaseLayer.setVisible(true);
			darkGrayReferenceLayer.setVisible(true);
			lightGrayBaseLayer.setVisible(false);
			lightGrayReferenceLayer.setVisible(false);
			document.getElementById("mapLayerButton").classList.add("selectedButton");
			IS_DARK = true;
			gtag('event', 'dark', {'event_category' : 'mapcontrol'});
			break;	
	}
	localStorage.setItem("IS_DARK",JSON.stringify(IS_DARK));
}

document.getElementById('darkBase').addEventListener('click', function (event) {
	event.target.classList.add("selected");
	document.getElementById("lightBase").classList.remove("selected");
	setMapLayer('dark');
});

document.getElementById('lightBase').addEventListener('click', function (event) {
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
	layer.set('info',layerInfo[wmslayer])
	if (document.getElementById(wmslayer)) {
		removeSelectedParameter("#" + layer.get("name") + " > div");
		document.getElementById(wmslayer).classList.add("selected");
	}
	layer.getSource().updateParams({ 'LAYERS': wmslayer });
	if (layer.getVisible()) {
		updateCanonicalPage();
	} else {
		layer.setVisible(true);
	}
}

function addEventListeners(selector) {
	let elementsArray = document.querySelectorAll(selector);
	elementsArray.forEach(function (elem) {
		debug("Activated event listener for " + elem.id);
		elem.addEventListener("click", function () {
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

function layerInfoPlaylist(event) {
	const layer = event.target;
	const name = layer.get('name')
	const info = layer.get('info')
	let opacity = layer.get('opacity') * 100
	let resolution = "";

	

	if (typeof info === "undefined") return
	debug("Updating playlist for " + name);
	if (typeof info.style !== "undefined") {
		if (info.style.length > 1) {
			const parent = document.getElementById(name + 'Styles');
			while (parent.firstChild) parent.removeChild(parent.firstChild);
			info.style.forEach(style => {
				let div = document.createElement("div");
				div.innerHTML = style.Title;
				div.id = style.Name;
				div.addEventListener('click', function () { setLayerStyle(layer, style.Name) });
				parent.appendChild(div);
			});
		}
	}

	if (typeof info.title !== "") {
		document.getElementById(name + 'Title').innerHTML = info.title;
	}

	if (typeof info.abstract !== "undefined") {
		document.getElementById(name + 'Abstract').innerHTML = info.abstract;
	}

	if (typeof info.attribution !== "undefined") {
		document.getElementById(name + 'Attribution').innerHTML = info.attribution.Title;
	}

	if (typeof info.time !== "undefined") {
		let timestep = Math.round(info.time.resolution / 60000)
		resolution = '<div><i class="material-icons">av_timer</i> ' + (timestep > 60 ? (timestep / 60) + ' tuntia' : timestep + ' min') + '</div>'
	}

	var infof = '<h4><i class="material-icons">check_box</i>' + info.title + '</h4>'  + resolution + '<div><i class="material-icons">opacity</i> <label for="' + name + 'Slider"></label> <input type="range" min="1" max="100" value="' + opacity + '" class="slider" id="' + name + 'Slider"></div>';
	if (layer.getVisible()) {
		document.getElementById(name + 'Info').classList.remove("playListDisabled");
	} else {
		document.getElementById(name + 'Info').classList.add("playListDisabled");
	}
	//document.getElementById(name + 'Info').innerHTML = info;
	// document.getElementById(name + 'Slider').addEventListener('input', function () {
	// 	layer.setOpacity(event.target.value / 100);
	// 	event.stopPropagation();
	// });
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
	updateCanonicalPage()
}

function onChangeSlider () {
	debug(this.value);
	radarLayer.setOpacity(this.value/100);
}

function toggleLayerVisibility(layer) {
	if (layer.getVisible()) {
		layer.setVisible(false);
	} else {
		layer.setVisible(true);
	}
}

//
// EVENTS
//

document.getElementById('speedButton').addEventListener('click', function() {
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
	gtag('event', 'speed', {'event_category' : 'timecontrol', 'event_label' : options.frameRate / options.defaultFrameRate + "×"});
});

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

document.getElementById('playlistButton').addEventListener('click', function() {
	debug("playlist");
	var elem = document.getElementById("playList");
	if (elem.style.bottom === '0px') {
		elem.style.bottom = '-600px';
	} else {
		elem.style.bottom = '0px';
	}
});

// Close playlist if clicked outside of playlist
window.addEventListener('click', function (e) {
	if (!document.getElementById('playList').contains(e.target)) {
		if (document.getElementById('playlistButton').contains(e.target)) return
		var elem = document.getElementById("playList");
		if (elem.style.bottom === '0px') {
			elem.style.bottom = '-600px';
		} 
	}
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

document.getElementById('locationLayerButton').addEventListener('click', function() {
	if (IS_TRACKING) {
		IS_TRACKING = false;
		localStorage.setItem("IS_TRACKING",JSON.stringify(false));
		gtag('event', 'off', {'event_category' : 'tracking'});
	} else {
		IS_TRACKING = true;
		localStorage.setItem("IS_TRACKING",JSON.stringify(true));
		if (ownPosition.length > 1) {
			map.getView().setCenter(ownPosition);
		}
		gtag('event', 'on', {'event_category' : 'tracking'});
	}
	setButtonStates();
});

document.getElementById('cursorDistanceTxt').addEventListener('click', function() {
	IS_NAUTICAL = IS_NAUTICAL ? false : true;
	localStorage.setItem("IS_NAUTICAL",JSON.stringify(IS_NAUTICAL));
});

document.getElementById('mapLayerButton').addEventListener('click', function() {
	if (IS_DARK) {
		setMapLayer('light');
	} else {
		setMapLayer('dark');
	}
});

document.getElementById('satelliteLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(satelliteLayer);
});

document.getElementById('satelliteLayerTitle').addEventListener('click', function() {
	toggleLayerVisibility(satelliteLayer);
});

document.getElementById('radarLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(radarLayer);
});

document.getElementById('radarLayerTitle').addEventListener('click', function() {
	toggleLayerVisibility(radarLayer);
});

document.getElementById('lightningLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(lightningLayer);
});

document.getElementById('lightningLayerTitle').addEventListener('click', function() {
	toggleLayerVisibility(lightningLayer);
});

document.getElementById('observationLayerButton').addEventListener('click', function() {
	toggleLayerVisibility(observationLayer);
});

document.getElementById('observationLayerTitle').addEventListener('click', function() {
	toggleLayerVisibility(observationLayer);
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

map.on('click', function(evt) {
	displayFeatureInfo(evt.pixel);
});

document.addEventListener('keydown', function (event) {
	if (event.key === 'Control') {
		document.getElementById('help').style.display = "block";
	}
});


document.addEventListener('keyup', function (event) {
	if (event.defaultPrevented) {
		return;
	}

	var key = event.key || event.keyCode;
	debug(event);
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
	} else 	if (event.key === 'Control') {
		document.getElementById('help').style.display = "none";
	}

});

function updateLayerSelection(ollayer,type,filter) {
	document.getElementById(type+"Layer-select").innerHTML="";
	Object.keys(layerInfo).forEach((layer) => {
		if (layerInfo[layer].layer.includes(filter)) { 
			var div = document.createElement("div");
			var resolution = Math.round(layerInfo[layer].time.resolution/60000);
			div.innerHTML = '<h4>' + layerInfo[layer].title + '</h4><p>' + layerInfo[layer].abstract + '</p> (<i>' + (resolution > 60 ? (resolution / 60) + ' hours' : resolution + ' minutes') + '</i>)';
			div.onclick = function () { updateLayer(ollayer,layerInfo[layer].layer); };
			document.getElementById(type+"Layer-select").appendChild(div);
		}
	})
}

function readWMSCapabilities(url,timeout) {
	var parser = new WMSCapabilities();
	debug("Request WMS Capabilities " + url);
	gtag('event', 'getCapabilities', {
		'event_category': 'WMS',
		'event_label': url
	});
	fetch(url + '?SERVICE=WMS&version=1.3.0&request=GetCapabilities').then(function (response) {
		return response.text();
	}).then(function (text) {
		debug("Received WMS Capabilities " + url);
		var result = parser.read(text);
		getLayers(result.Capability.Layer.Layer);
		// if (typeof (radarLayer.time) === "undefined") {
		// 	radarLayer.time = layerInfo[metRadarLayer].time;
		// }
		debug(layerInfo);
		satelliteLayer.set('info',layerInfo[satelliteLayer.getSource().getParams().LAYERS])
		radarLayer.set('info',layerInfo[radarLayer.getSource().getParams().LAYERS])
		lightningLayer.set('info',layerInfo[lightningLayer.getSource().getParams().LAYERS])
		observationLayer.set('info',layerInfo[observationLayer.getSource().getParams().LAYERS])
		updateLayerSelection(satelliteLayer,"satellite","msg_");
		updateLayerSelection(observationLayer,"observation","_tempe");
		updateLayerSelection(radarLayer,"radar","radar_");
		//updateLayerSelection(radarLayer,"etop","etop_");
		//updateLayerSelection(radarLayer,"hclass","_hclass");
		updateLayerSelection(lightningLayer,"lightning","lightning");
		if (IS_FOLLOWING) {
			setTime('last');
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

	if (typeof layer.Attribution !== "undefined") {
		product.attribution = layer.Attribution
	}

	if (typeof layer.Dimension !== "undefined") {
		product.time = getTimeDimension(layer.Dimension)
	}
	if (typeof layer.Style !== "undefined") {
		product.style = layer.Style;
	}
	return product
}

function getStyles(styles) {
	styles.forEach((style) => {
		debug(style);
	});
}

function getAtributions(attributions) {
	attributions.forEach((attribution) => {
		debug(attribution);
	});
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

// Get the modal
var modal = document.getElementById("myModal");

// Get the button that opens the modal
var btn = document.getElementById("layersButton");

// Get the <span> element that closes the modal
var span = document.getElementsByClassName("close")[0];

// When the user clicks on the button, open the modal 
btn.onclick = function() {
  modal.style.display = "block";
}

// When the user clicks on <span> (x), close the modal
span.onclick = function() {
  modal.style.display = "none";
}

// When the user clicks anywhere outside of the modal, close it
window.onclick = function (event) {
	if (event.target == modal) {
		modal.style.display = "none";
	}
}

// MAIN
const main = () => {
	// Load custom tracking code lazily, so it's non-blocking.
	import('./analytics.js').then((analytics) => { analytics.init(); updateCanonicalPage()});
	
	createTimeline(13);

	if (IS_DARK) {
		setMapLayer('dark');
	} else {
		setMapLayer('light');
	}

	updateClock();
	readWMSCapabilities(options.wmsServer.meteo.test, 300000);
	readWMSCapabilities(options.wmsServer.meteo.radar, 60000);
	//if (IS_SATELLITE) {
		readWMSCapabilities(options.wmsServer.eumetsat, 300000);
	//}	
	
	setButtonStates();

	// GEOLOCATION
	var geolocation = new Geolocation({
		trackingOptions: {
			enableHighAccuracy: true
		},
		projection: map.getView().getProjection()
	});
	geolocation.setTracking(true);
	geolocation.on('error', function (error) { debug(error.message) });
	geolocation.on('change:accuracyGeometry',onChangeAccuracyGeometry);
	geolocation.on('change:position', onChangePosition);

	satelliteLayer.on('change:visible', onChangeVisible);
	satelliteLayer.on('propertychange', layerInfoPlaylist);
	radarLayer.on('change:visible', onChangeVisible);
	radarLayer.on('propertychange', layerInfoPlaylist);
	lightningLayer.on('change:visible', onChangeVisible);
	lightningLayer.on('propertychange', layerInfoPlaylist);
	observationLayer.on('change:visible', onChangeVisible);
	observationLayer.on('propertychange', layerInfoPlaylist);

	//radarLayer.on('change', function (event) {debug(event.target.getSource().getParams().TIME)});

	addEventListeners("#satelliteLayer > div");
	addEventListeners("#radarLayer > div");
	addEventListeners("#lightningLayer > div");
	addEventListeners("#observationLayer > div");

	window.matchMedia("(prefers-color-scheme: dark)").addListener(function(x) {
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

//const worker = new Worker();
//worker.postMessage([options.wmsServer.meteo.radar, 60000]);
//worker.onmessage = function (event) {};
//worker.addEventListener("message", function (event) {debug(event)});

};

main();