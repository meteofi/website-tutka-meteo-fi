import {Map, View} from 'ol';
import {FullScreen, MousePosition} from 'ol/control.js';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import GeoJSON from 'ol/format/GeoJSON.js';
import Vector from 'ol/source/Vector';
import {fromLonLat} from 'ol/proj';
import sync from 'ol-hashed';
import Feature from 'ol/Feature';
import {circular} from 'ol/geom/Polygon';
import {getDistance} from 'ol/sphere.js';
import Point from 'ol/geom/Point';
import {createStringXY} from 'ol/coordinate.js';
import {Fill, Stroke, Style, Text} from 'ol/style.js';
import Dms from 'geodesy/dms.js';
import WMSCapabilities from 'ol/format/WMSCapabilities.js';

var DEBUG = true;
var metLatitude  = localStorage.getItem("metLatitude")  ? localStorage.getItem("metLatitude")  : 60.2706;
var metLongitude = localStorage.getItem("metLongitude") ? localStorage.getItem("metLongitude") : 24.8725;
var metRadarLayer = localStorage.getItem("metRadarLayer") ? localStorage.getItem("metRadarLayer") : "MeteoFI:radar_finland_dbz";
var ownPosition;
var startDate = threeHoursAgo();
var frameRate = 0.5; // frames per second
var animationId = null;
var moment = require('moment');
var layerInfo = {};
moment.locale('fi');

function debug(str)
{
    if (DEBUG)
        {
            try {
                console.log(str);
            } catch (e) {};
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

function threeHoursAgo() {
	return new Date(Math.round(Date.now() / 3600000) * 3600000 - 3600000 * 1);
}

readWMSCapabilities();


	// Radar Layer
	var radarLayer = new ImageLayer({
		opacity: 0.7,
		source: new ImageWMS({
			url: 'https://wms.meteo.fi/geoserver/wms',
			//params: { 'LAYERS': metRadarLayer, 'STYLES': 'radar_finland_bookbinder' },
			params: { 'LAYERS': metRadarLayer },
			ratio: 1,
			serverType: 'geoserver'
		})
	});

var layers = [

	new TileLayer({
		source: new XYZ({
			attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
				'rest/services/Canvas/World_Dark_Gray_Base/MapServer">ArcGIS</a>',
			url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
				'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
		})
	}),

  radarLayer,

	new TileLayer({
		source: new XYZ({
			attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/' +
				'rest/services/Canvas/World_Dark_Gray_Reference/MapServer">ArcGIS</a>',
			url: 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
				'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
		})
	}),

	new VectorLayer({
		source: new Vector({
			format: new GeoJSON(),
			url: 'radars-finland.json'
		})//,
		//style: function(feature) {
		//	style.getText().setText(feature.get('name'));
		//	return style;
		//}
	}),


	new VectorLayer({
		source: new Vector()
	})

]; // layers

var mousePositionControl = new MousePosition({
	coordinateFormat: createStringXY(4),
	projection: 'EPSG:4326',
	// comment the following two lines to have the mouse position
	// be placed within the map.
	//className: 'custom-mouse-position',
	//target: document.getElementById('mouse-position'),
	undefinedHTML: '&nbsp;'
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


navigator.geolocation.watchPosition(function(pos) {
	const coords = [pos.coords.longitude, pos.coords.latitude];
	ownPosition = coords;
	const accuracy = circular(coords, pos.coords.accuracy);
	document.getElementById("positionTxt").innerHTML = "&#966; " + Dms.toLat(pos.coords.latitude, "dm", 3) + "<br/>" + "&#955; " + Dms.toLon(pos.coords.longitude, "dm", 3);
	//document.getElementById("infoItemPosition").style.display = "initial";
  layers[4].getSource().clear(true);
  layers[4].getSource().addFeatures([
    new Feature(accuracy.transform('EPSG:4326', map.getView().getProjection())),
    new Feature(new Point(fromLonLat(coords)))
  ]);
}, function(error) {
  debug(`ERROR: ${error.message}`);
}, {
  enableHighAccuracy: true
});

function updateLayer(layer) {
	radarLayer.getSource().updateParams({ 'LAYERS': layer });
}

function setLayerTime (layer, time) {
	layer.getSource().updateParams({ 'TIME': time });
  
	document.getElementById("radarDateValue").innerHTML = moment(time).format('l');
	document.getElementById("radarTimeValue").innerHTML = moment(time).format('LT');
}

function setTime() {
	var resolution = layerInfo[metRadarLayer].time.resolution;
	startDate.setMinutes(startDate.getMinutes() + resolution / 60000);

	if (startDate.getTime() > layerInfo[metRadarLayer].time.end) {
		startDate = new Date(Math.round(Date.now() / resolution) * resolution - resolution * 12);
	}

	setLayerTime(radarLayer,startDate.toISOString());
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
	document.getElementById("currentTimeTxt").innerHTML = [lt.format('l'), lt.format('LTS')+' LT', utc.format('LTS')+" UTC"].join('<br/>');

	// call this function again in 1000ms
	setTimeout(updateClock, 1000);
}

function updateLayerInfo() {
	readWMSCapabilities();
	// call this function again in 1000ms
	setTimeout(updateLayerInfo, 60000);
}

var play = function () {
	stop();
	animationId = window.setInterval(setTime, 500);
};

// Start Animation
//document.getElementById("infoItemPosition").style.display = "none";

play();
updateClock();
updateLayerInfo();



document.getElementById('dbz').addEventListener('click', function(event) {
	debug("DBZ")
	updateLayer(metRadarLayer);
});

document.getElementById('vrad').addEventListener('click', function(event) {
	debug("RR")
	updateLayer(metRadarLayer);
});


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

	var info = document.getElementById('radarTxt');
	if (feature) {
		var distance = getDistance(ownPosition,[24,60]);
		info.innerHTML = feature.get('acronym') + ': ' + feature.get('name') + ' ' + Math.round(distance/1000) + 'km';
	} else {
		info.innerHTML = '&nbsp;';
	}

	if (feature !== highlight) {
		if (highlight) {
			featureOverlay.getSource().removeFeature(highlight);
		}
		if (feature) {
			featureOverlay.getSource().addFeature(feature);
			//featureOverlay.getSource().addFeature(circular(feature.getGeometry().getCoordinates(), 240000));
		}
		highlight = feature;
	}

};

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
//	$('#infoItemPosition').hide();
}

function geoLocationUpdate(location) {
	localStorage.setItem("metLatitude", location.coords.latitude);
	localStorage.setItem("metLongitude", location.coords.longitude);
	metLatitude = location.coords.latitude;
	metLongitude = location.coords.longitude;
//	$('#positionTxt').html("&#966; " + Dms.toLat(metLatitude, "dm", 3) + "<br/>" + "&#955; " + Dms.toLon(metLongitude, "dm", 3));
//	$('#infoItemPosition').show();
}

// Events

map.on('pointermove', function(evt) {
	if (evt.dragging) {
		return;
	}
	var pixel = map.getEventPixel(evt.originalEvent);
	displayFeatureInfo(pixel);
});

map.on('click', function(evt) {
	displayFeatureInfo(evt.pixel);
});

document.addEventListener('keyup', function (event) {
	debug("stop");
	if (event.defaultPrevented) {
			return;
	}

	var key = event.key || event.keyCode;
debug(event);
	if (key === ' ' || key === 'Space' || key === 32) {

		stop();
	}
});

function readWMSCapabilities() {
	var parser = new WMSCapabilities();
	fetch('https://wms.meteo.fi/geoserver/ows?service=wms&version=1.3.0&request=GetCapabilities').then(function (response) {
		return response.text();
	}).then(function (text) {
		var result = parser.read(text);
		getLayers(result.Capability.Layer.Layer)
	//	debug(products);
	//	return products;
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
	console.log('Title: ' + layer.Title + ' Name: ' + layer.Name)
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
	console.log("start: " + beginTime + " end: " + endTime + " resolution: " + resolutionTime + " type: " + type + " default: " + defaultTime)
	return { start: beginTime, end: endTime, resolution: resolutionTime, type: type, default: defaultTime }
}
