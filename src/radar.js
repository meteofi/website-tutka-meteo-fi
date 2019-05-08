import {Map, View} from 'ol';
import {FullScreen, MousePosition} from 'ol/control.js';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import GeoJSON from 'ol/format/GeoJSON.js';
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
	frameRate: 0.5,
}

var DEBUG = true;
var metLatitude  = localStorage.getItem("metLatitude")  ? localStorage.getItem("metLatitude")  : 60.2706;
var metLongitude = localStorage.getItem("metLongitude") ? localStorage.getItem("metLongitude") : 24.8725;
var metRadarLayer = localStorage.getItem("metRadarLayer") ? localStorage.getItem("metRadarLayer") : "MeteoFI:radar_finland_dbz";
var ownPosition = [];
var startDate = threeHoursAgo();
var frameRate = 0.5; // frames per second
var animationId = null;
var moment = require('moment');
moment.locale('fi');
var layerInfo = {};
const client  = connect('wss://meri.digitraffic.fi:61619/mqtt',{username: 'digitraffic', password: 'digitrafficPassword'});
const WMSURL = "https://wms.meteo.fi/geoserver/wms";
var trackedVessels = {'230059770': {}, '230994270': {}, '230939100': {}, '230051170': {}, '230059740': {}, '230108850': {}, '230937480': {}, '230051160': {}, '230983250': {}, '230012240': {}, '230980890': {}, '230061400': {}, '230059760': {}, '230005610': {}, '230987580': {}, '230983340': {}, '230111580': {}, '230059750': {}, '230994810': {}, '230993590': {}, '230051150': {} };


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
		color: 'gray',
		width: 1
	})
});

function threeHoursAgo() {
	return new Date(Math.round(Date.now() / 3600000) * 3600000 - 3600000 * 1);
}

//readWMSCapabilities();

// Setup Layers


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

	// Radar Layer
	var radarLayer = new ImageLayer({
		opacity: 0.7,
		source: new ImageWMS({
			url: WMSURL,
			//params: { 'LAYERS': metRadarLayer, 'STYLES': 'radar_finland_dbz_fmi' },
			params: { 'LAYERS': metRadarLayer },
			ratio: 1,
			serverType: 'geoserver'
		})
	});

	// Lightning Layer
	var lightningLayer = new ImageLayer({
		source: new ImageWMS({
			url: WMSURL,
			params: { 'LAYERS': 'observation:lightning' },
			ratio: 1,
			serverType: 'geoserver'
		})
	});

	// Observation Layer
	var observationLayer = new ImageLayer({
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
		})//,
		//style: function(feature) {
		//	style.getText().setText(feature.get('mmsi'));
		//	return style;
		//}
	});

	var smpsLayer = new VectorLayer({
		source: new Vector(),
		visible: false,
		style: function(feature) {
			vesselStyle.getText().setText(getVesselName(feature.get('mmsi')) + " " + feature.get('sog')+"kn");
			return vesselStyle;
		}
	});

	var guideLayer = new VectorLayer({
		source: new Vector(),
		style: rangeStyle
	});




var layerss = {
	"radarLayer": radarLayer,
	"observationLayer": observationLayer,
	"lightningLayer": lightningLayer
}

var layers = [

	lightGrayBaseLayer,
	darkGrayBaseLayer,
	radarLayer,
	guideLayer,
	lightningLayer,
	lightGrayReferenceLayer,
	darkGrayReferenceLayer,
	observationLayer,

  positionLayer,


	new VectorLayer({
		source: new Vector()
	}),

	smpsLayer

]; // layers


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
	// comment the following two lines to have the mouse position
	// be placed within the map.
	className: 'custom-mouse-position',
	target: document.getElementById('cursorTxt'),
	undefinedHTML: 'Cursor not on map'
});

const map = new Map({
  target: 'map',
	layers: layers,
	controls: [
		new FullScreen(), mousePositionControl
	],
  view: new View({
		enableRotation: false,
    center: fromLonLat([26, 65]),
    zoom: 5
  })
});

sync(map);

//radarRangeRings([24.8690,60.2706],"250000");

//	new Feature(ring.transform('EPSG:4326', map.getView().getProjection()))"
function radarRangeRings (layer, coordinates, range) {
	const ring = circular(coordinates, range);
	layer.getSource().addFeatures([
		new Feature(ring.transform('EPSG:4326', map.getView().getProjection()))
	]);	
}

function bearingLine(layer, coordinates, range, direction)
{
    var c = new LatLon(coordinates[1], coordinates[0]);
    var p1 = c.destinationPoint(50000, direction);
		var p2 = c.destinationPoint(range*1000, direction);
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
  positionLayer.getSource().clear(true);
  positionLayer.getSource().addFeatures([
    new Feature(accuracy.transform('EPSG:4326', map.getView().getProjection())),
    new Feature(new Point(fromLonLat(coords)))
  ]);
}, function(error) {
  debug(`ERROR: ${error.message}`);
}, {
  enableHighAccuracy: true
});

function updateLayer(layer,wmslayer) {
	metRadarLayer=wmslayer;
	debug(layerInfo[wmslayer]);
	if (typeof (layerInfo[metRadarLayer]) !== "undefined") {
		layer.time = layerInfo[wmslayer].time;
	}
	layer.getSource().updateParams({ 'LAYERS': wmslayer });
	//gtag('event', 'screen_view', { 'screen_name': layer});
}

function setLayerTime(layer, time) {
	layer.getSource().updateParams({ 'TIME': time });
	if (moment(time).isValid()) {
		document.getElementById("radarDateValue").innerHTML = moment(time).format('l');
		document.getElementById("radarTimeValue").innerHTML = moment(time).format('LT');
	}
}

function setTime() {
	if (typeof (layerInfo[metRadarLayer]) !== "undefined") {
		var resolution = layerInfo[metRadarLayer].time.resolution;
		startDate.setMinutes(startDate.getMinutes() + resolution / 60000);

		if (startDate.getTime() > layerInfo[metRadarLayer].time.end) {
			startDate = new Date(Math.round(moment(layerInfo[metRadarLayer].time.end).valueOf() / resolution) * resolution - resolution * 12);
		}

		setLayerTime(radarLayer, startDate.toISOString());
		setLayerTime(lightningLayer, 'PT5M/' + startDate.toISOString());
		setLayerTime(observationLayer, startDate.toISOString());
	} 
}

var stop = function () {
	if (animationId !== null) {
		window.clearInterval(animationId);
		animationId = null;
	}
};

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

function updateLayerInfo() {
	readWMSCapabilities();
	setTimeout(updateLayerInfo, 60000);
}

var play = function () {
	stop();
	animationId = window.setInterval(setTime, 250);
};

var playstop = function () {
	if (animationId !== null) {
		window.clearInterval(animationId);
		animationId = null;
		document.getElementById("playstop").innerHTML = "play_arrow";
	} else {
		animationId = window.setInterval(setTime, 250);
		document.getElementById("playstop").innerHTML = "pause";
	}
};

// Start Animation
//document.getElementById("infoItemPosition").style.display = "none";
document.getElementById("cursorDistanceTxtKM").style.display = "none";
document.getElementById("cursorDistanceTxtNM").style.display = "none";

updateClock();
updateLayerInfo();

Object.keys(trackedVessels).forEach(function (item) {
	debug("Subscribed vessel " + item + " locations");
	client.subscribe("vessels/" + item + "/+");
});

//client.subscribe("vessels/230994270/locations");
//client.subscribe("vessels/230939100/locations");

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

function addEventListeners(selector) {
	let elementsArray = document.querySelectorAll(selector);
	elementsArray.forEach(function (elem) {
		debug("Activated event listener for " + elem);
		elem.addEventListener("click", function () {
			removeSelectedParameter("#" + event.target.parentElement.id + " > div");
			event.target.classList.add("selected");
			if (event.target.id.indexOf("Off") !== -1) {
				debug("Deactivated layer " + event.target.parentElement.id);
				layerss[event.target.parentElement.id].setVisible(false);
			} else {
				debug("Activated layer " + event.target.id);
				updateLayer(layerss[event.target.parentElement.id], event.target.id);
				layerss[event.target.parentElement.id].setVisible(true);
			}
		});
	});
}

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
			[50000,100000,150000,200000,250000].forEach(range => radarRangeRings(guideLayer, coords, range));
			[0,45,90,135,180,225,270,315].forEach(bearing => bearingLine(guideLayer, coords, 250, bearing));
			map.getView().fit(guideLayer.getSource().getExtent(), map.getSize()); 
		}
		highlight = feature;
	}

};

function toggleLayerVisibility(layer) {
	var visibility = layer.getVisible();
	if (visibility == false) {
		layer.setVisible(true);
	}
	if (visibility == true) {
		layer.setVisible(false);
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

document.getElementById('playstop').addEventListener('click', function() {
	debug("playstop");
	playstop();
});


// map.on('pointermove', function(evt) {
// 	if (evt.dragging) {
// 		return;
// 	}
// 	var pixel = map.getEventPixel(evt.originalEvent);
// 	displayFeatureInfo(pixel);
// });

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
		playstop();
	} else if (key === 's' || key === 'KeyS' || key === 83) {
		toggleLayerVisibility(smpsLayer);
	} else if (key === '+' || key === 'NumpadAdd') {
		map.getView().setZoom(map.getView().getZoom()+1);    
	} else if (key === '-' || key === 'NumpadSubtract') {
		map.getView().setZoom(map.getView().getZoom()-1);    
	} else if (key === '1' || key === 'Digit1') {
		toggleLayerVisibility(radarLayer);
		removeSelectedParameter("#radarLayer > div");
		document.getElementById("radarOff").classList.add("selected");
	} else if (key === '2' || key === 'Digit2') {
		toggleLayerVisibility(lightningLayer);    
	} else if (key === '3' || key === 'Digit3') {
		toggleLayerVisibility(observationLayer);    
	}

});

function readWMSCapabilities() {
	var parser = new WMSCapabilities();
	debug("Request WMS Capabilities");
	fetch(WMSURL + '?version=1.3.0&request=GetCapabilities').then(function (response) {
		return response.text();
	}).then(function (text) {
		debug("Received WMS Capabilities");
		var result = parser.read(text);
		getLayers(result.Capability.Layer.Layer);

	});
}

function getLayers(parentlayer) {
	let products = {}
	parentlayer.forEach((layer) => {
		if (Array.isArray(layer.Layer)) {
			//console.log(layer.Title)
			//products = products.concat(getLayers(layer.Layer))
		} else {
			layerInfo[layer.Name] = getLayerInfo(layer)
		}
	})
	return products;
}

function getLayerInfo(layer) {
	//console.log('Title: ' + layer.Title + ' Name: ' + layer.Name)
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
