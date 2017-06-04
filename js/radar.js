// https://github.com/beaugrantham/wmsmaptype
// Geodesy functions The MIT Licence Copyright (c) 2014 Chris Veness [https://github.com/chrisveness/geodesy]

var map;
var DEBUG = true;
var selectedLayer;
var featureInfoDone = true;

// Remember previous state
var metLatitude  = localStorage.getItem("metLatitude")  ? localStorage.getItem("metLatitude")  : 60.2706;
var metLongitude = localStorage.getItem("metLongitude") ? localStorage.getItem("metLongitude") : 24.8725;
var metSite      = localStorage.getItem("metSite")      ? localStorage.getItem("metSite")      : "vantaa";
var metParameter = localStorage.getItem("metParameter") ? localStorage.getItem("metParameter") : "dbz";
var metMapZoom   = localStorage.getItem("metMapZoom")   ? localStorage.getItem("metMapZoom")   : 8;

var mapStyleDefault = [{"featureType":"water","elementType":"geometry.fill","stylers":[{"color":"#d3d3d3"}]},{"featureType":"transit","stylers":[{"color":"#808080"},{"visibility":"off"}]},{"featureType":"road.highway","elementType":"geometry.stroke","stylers":[{"visibility":"on"},{"color":"#b3b3b3"}]},{"featureType":"road.highway","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"road.local","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#ffffff"},{"weight":1.8}]},{"featureType":"road.local","elementType":"geometry.stroke","stylers":[{"color":"#d7d7d7"}]},{"featureType":"poi","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#ebebeb"}]},{"featureType":"administrative","elementType":"geometry","stylers":[{"color":"#a7a7a7"}]},{"featureType":"road.arterial","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"road.arterial","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"landscape","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#efefef"}]},{"featureType":"road","elementType":"labels.text.fill","stylers":[{"color":"#696969"}]},{"featureType":"administrative","elementType":"labels.text.fill","stylers":[{"visibility":"on"},{"color":"#737373"}]},{"featureType":"poi","elementType":"labels.icon","stylers":[{"visibility":"off"}]},{"featureType":"poi","elementType":"labels","stylers":[{"visibility":"off"}]},{"featureType":"road.arterial","elementType":"geometry.stroke","stylers":[{"color":"#d6d6d6"}]},{"featureType":"road","elementType":"labels.icon","stylers":[{"visibility":"off"}]},{},{"featureType":"poi","elementType":"geometry.fill","stylers":[{"color":"#dadada"}]}];

var mapStyleDarkWorld = [{"stylers":[{"visibility":"simplified"}]},{"stylers":[{"color":"#131314"}]},{"featureType":"water","stylers":[{"color":"#131313"},{"lightness":7}]},{"elementType":"labels.text.fill","stylers":[{"visibility":"on"},{"lightness":25}]}];

var mapStyleNeutralBlue = [{"featureType":"water","elementType":"geometry","stylers":[{"color":"#193341"}]},{"featureType":"landscape","elementType":"geometry","stylers":[{"color":"#2c5a71"}]},{"featureType":"road","elementType":"geometry","stylers":[{"color":"#29768a"},{"lightness":-37}]},{"featureType":"poi","elementType":"geometry","stylers":[{"color":"#406d80"}]},{"featureType":"transit","elementType":"geometry","stylers":[{"color":"#406d80"}]},{"elementType":"labels.text.stroke","stylers":[{"visibility":"on"},{"color":"#3e606f"},{"weight":2},{"gamma":0.84}]},{"elementType":"labels.text.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"administrative","elementType":"geometry","stylers":[{"weight":0.6},{"color":"#1a3541"}]},{"elementType":"labels.icon","stylers":[{"visibility":"off"}]},{"featureType":"poi.park","elementType":"geometry","stylers":[{"color":"#2c5a71"}]}];

var mapStyleLightGray = [{"featureType":"water","elementType":"geometry.fill","stylers":[{"color":"#d3d3d3"}]},{"featureType":"transit","stylers":[{"color":"#808080"},{"visibility":"off"}]},{"featureType":"road.highway","elementType":"geometry.stroke","stylers":[{"visibility":"on"},{"color":"#b3b3b3"}]},{"featureType":"road.highway","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"road.local","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#ffffff"},{"weight":1.8}]},{"featureType":"road.local","elementType":"geometry.stroke","stylers":[{"color":"#d7d7d7"}]},{"featureType":"poi","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#ebebeb"}]},{"featureType":"administrative","elementType":"geometry","stylers":[{"color":"#a7a7a7"}]},{"featureType":"road.arterial","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"road.arterial","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"landscape","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#efefef"}]},{"featureType":"road","elementType":"labels.text.fill","stylers":[{"color":"#696969"}]},{"featureType":"administrative","elementType":"labels.text.fill","stylers":[{"visibility":"on"},{"color":"#737373"}]},{"featureType":"poi","elementType":"labels.icon","stylers":[{"visibility":"off"}]},{"featureType":"poi","elementType":"labels","stylers":[{"visibility":"off"}]},{"featureType":"road.arterial","elementType":"geometry.stroke","stylers":[{"color":"#d6d6d6"}]},{"featureType":"road","elementType":"labels.icon","stylers":[{"visibility":"off"}]},{},{"featureType":"poi","elementType":"geometry.fill","stylers":[{"color":"#dadada"}]}];

function debug(str) {
	if (DEBUG) {
		try {
			console.log(str);
		} catch (e) { };
	}
}

function initMap() {
    updateClock();
    // Create a map object and specify the DOM element for display.
    map = new google.maps.Map(document.getElementById('map'), {
	    center: {lat: 64, lng: 24},
	    zoom: 6,
	    mapTypeControl: false,
	    streetViewControl: false,
	    mapTypeControlOptions: {
		mapTypeIds: [google.maps.MapTypeId.ROADMAP, 'map_style']
	    },
	    styles: mapStyleDefault,
	    //	    styles: [{"featureType":"water","elementType":"geometry.fill","stylers":[{"color":"#d3d3d3"}]},{"featureType":"transit","stylers":[{"color":"#808080"},{"visibility":"off"}]},{"featureType":"road.highway","elementType":"geometry.stroke","stylers":[{"visibility":"on"},{"color":"#b3b3b3"}]},{"featureType":"road.highway","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"road.local","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#ffffff"},{"weight":1.8}]},{"featureType":"road.local","elementType":"geometry.stroke","stylers":[{"color":"#d7d7d7"}]},{"featureType":"poi","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#ebebeb"}]},{"featureType":"administrative","elementType":"geometry","stylers":[{"color":"#a7a7a7"}]},{"featureType":"road.arterial","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"road.arterial","elementType":"geometry.fill","stylers":[{"color":"#ffffff"}]},{"featureType":"landscape","elementType":"geometry.fill","stylers":[{"visibility":"on"},{"color":"#efefef"}]},{"featureType":"road","elementType":"labels.text.fill","stylers":[{"color":"#696969"}]},{"featureType":"administrative","elementType":"labels.text.fill","stylers":[{"visibility":"on"},{"color":"#737373"}]},{"featureType":"poi","elementType":"labels.icon","stylers":[{"visibility":"off"}]},{"featureType":"poi","elementType":"labels","stylers":[{"visibility":"off"}]},{"featureType":"road.arterial","elementType":"geometry.stroke","stylers":[{"color":"#d6d6d6"}]},{"featureType":"road","elementType":"labels.icon","stylers":[{"visibility":"off"}]},{},{"featureType":"poi","elementType":"geometry.fill","stylers":[{"color":"#dadada"}]}],
        });
    map.fitBounds(bounds.finland);
    debug("Map initiated: " + bounds.finland);

    var borders = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"https://wms.meteo.fi/geoserver/wms",
					{layers: "naturalearth:ne_10m_admin_0_countries", transparent: true},
					{cache: true});

    var kunnat = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"https://wms.meteo.fi/geoserver/wms",
					{layers: "maanmittauslaitos:kuntajako", transparent: true},
					{cache: true});

    var turvalaitteet = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"https://wms.meteo.fi/geoserver/wms",
					{layers: "liikennevirasto.meriliikenne:merikartta", transparent: true},
					{cache: true});

    var vaylaalueet = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"https://wms.meteo.fi/geoserver/wms",
					{layers: "liikennevirasto.meriliikenne:vaylaalueet", transparent: true},
					{cache: true});

    var vaylat = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"https://wms.meteo.fi/geoserver/wms",
					{layers: "liikennevirasto.meriliikenne:vaylat", transparent: true},
					{cache: true});

    var precip = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"http://data.meteo.fi/wms",
					{layers: "meteo:gem:precipitation", transparent: true});

    var d=new Date();
    var dd=new Date(Math.floor(d.getTime()/10800000)*10800000);
    var now=dd.toISOString();

    var temperature = new WmsMapType(
					"Historical NEXRAD Base Reflectivity",
					"https://meteo.fi/geoserver/wms",
					{layers: "surface_observation_temp", transparent: true, time: now});

    borders.addToMap(map);
    kunnat.addToMap(map);
    //    vaylaalueet.addToMap(map);
    //vaylaalueet.setOpacity(1);
    //vaylat.addToMap(map);
    //vaylat.setOpacity(1);
    //    turvalaitteet.addToMap(map);
    //turvalaitteet.setOpacity(1);

    $.each( radars, function( site, radar ) {
	    debug("New site marker for: " + radar.name);

	    radars[site].marker = new google.maps.Marker({
		    position: radar.location,
		    map: map,
		    site: site,
		    icon: {
			url: 'https://maps.google.com/mapfiles/kml/pal4/icon49.png',
			anchor: new google.maps.Point(12,12),
			scaledSize: new google.maps.Size(24,24)
		    }
		});



		radars[site].bearingLine = [];
		for (var bearing = 0; bearing < 360; bearing = bearing + 45) {
			radars[site].bearingLine[bearing] = bearingLine(map, radars[site].marker.position.lat(), radars[site].marker.position.lng(), bearing, 250);
			radars[site].bearingLine[bearing].setVisible(false);
		}

		radars[site].rangeMarker = [];
		for (var radius = 50; radius <= 250; radius = radius + 50) {
			radars[site].rangeMarker[radius] = rangeMarker(map, radars[site].marker.position.lat(), radars[site].marker.position.lng(), radius);
			radars[site].rangeMarker[radius].setVisible(false);
		}
	    

	    
	    radars[site].marker.addListener('click', function() {
		    selectRadar(this.site);
		});
	}); // each

    
    google.maps.event.addListener(map, 'mousemove', function (event) {
	    updateCursorInfo(event.latLng.lat(),event.latLng.lng());               
	});


    // Start Position Watch
    if ("geolocation" in navigator) {
	var watchIdG  = navigator.geolocation.watchPosition(geoLocationUpdate,geoLocationFail,{enableHighAccuracy:true});
        debug("Started geolocation watch position. ("+watchIdG+")");
    } else {
        debug("Geolocation is not supported by this browser.");
    }
    
    // default action
    selectRadar(metSite);

}

function rangeMarker(map, lat, lon, radius)
{
	var rangeMarker = new google.maps.Circle({
		strokeColor: '#333333',
		strokeOpacity: 0.5,
		strokeWeight: 1,
		//fillColor: '#FF0000',
				fillOpacity: 0,
		map: map,
		center: {lat: lat, lng: lon},
		radius: radius*1000
	    });

	rangeMarker.addListener('mousemove', function(event) {
	        updateCursorInfo(event.latLng.lat(),event.latLng.lng());               
	    });
	return rangeMarker;
}


function bearingLine(map, lat, lon, direction, range)
{
    var c = new LatLon(lat, lon);
    var p1 = c.destinationPoint(50000, direction);
    var p2 = c.destinationPoint(range*1000, direction);

    var bearingLine = new google.maps.Polyline({
	    path: [{lat: p1.lat, lng: p1.lon}, {lat: p2.lat, lng: p2.lon}],
	    geodesic: true,
	    strokeColor: '#333333',
	    strokeOpacity: 0.5,
	    strokeWeight: 1,
	    map: map
	});
    return bearingLine;
//        path.setMap(map);
}

function hideRadarGuides() {

	$.each(radars, function (site, radar) {
		for (var bearing = 0; bearing < 360; bearing = bearing + 45) {
			radars[site].bearingLine[bearing].setVisible(false);
		}
		for (var radius = 50; radius <= 250; radius = radius + 50) {
			radars[site].rangeMarker[radius].setVisible(false);
		}
	});

}

function selectParameter(parameter) {
	localStorage.setItem("metParameter", parameter);
	metParameter = parameter;
	if (typeof selectedLayer !== 'undefined') {
		selectedLayer.removeFromMap(map);
	}
	selectedLayer = new WmsMapType(
		"Historical NEXRAD Base Reflectivity",
		"https://meteo.fi/geoserver/wms",
		{ layers: "radar_" + metSite + "_" + parameter, transparent: true });
	selectedLayer.addToMap(map);
	updateRadarInfo(metSite);
	debug("Selected parameter " + parameter)
}

function selectRadar(site) {

	localStorage.setItem("metSite", site);
	metSite = site;
	if (typeof selectedLayer !== 'undefined') {
		selectedLayer.removeFromMap(map);
	}
	selectedLayer = new WmsMapType(
		"Historical NEXRAD Base Reflectivity",
		"https://meteo.fi/geoserver/wms",
		{ layers: "radar_" + site + "_dbz", transparent: true });
	selectedLayer.addToMap(map);

	map.fitBounds(radars[site].rangeMarker[250].getBounds());
	hideRadarGuides();
	for (var bearing = 0; bearing < 360; bearing = bearing + 45) {
		radars[site].bearingLine[bearing].setVisible(true);
	}
	for (var radius = 50; radius <= 250; radius = radius + 50) {
		radars[site].rangeMarker[radius].setVisible(true);
	}
	updateRadarInfo(site);
	debug("Selected radar site " + radars[site].name)
}

Number.prototype.pad = function(size) { 
    return ('000000000' + this).substr(-size);
} 

function updateCursorInfo(lat,lon) {
    var p1 = new LatLon(metLatitude, metLongitude);
    var p2 = new LatLon(lat, lon);
    var d = p1.distanceTo(p2)/1000; 
    var b = p1.bearingTo(p2); 
    $('#cursorTxt').html("&#966; " + Dms.toLat(lat, "dm", 3) + "<br/>" + "&#955; " + Dms.toLon(lon, "dm", 3)+ "<br/>&#x2194; " + Math.round(d) + " km &#x29A3; " + Math.round(b).pad(3) + "&deg;<br><div id='dbz'></div>");
    url="https://meteo.fi/geoserver/wms?REQUEST=GetFeatureInfo&BBOX="+lat+","+lon+","+(lat+0.0001)+","+(lon+0.0001)+"&SERVICE=WMS&INFO_FORMAT=application/json&QUERY_LAYERS=MeteoFI%3Aradar_"+metSite+"_dbz&FEATURE_COUNT=50&Layers=MeteoFI%3Aradar_"+metSite+"_dbz&WIDTH=1&HEIGHT=1&format=image%2Fjpeg&styles=&crs=EPSG:4326&version=1.3.0&j=0&i=0";
    if (featureInfoDone == true) {
	featureInfoDone = false;
	$.getJSON(url,updatePixelValue);
    }
}

function updatePixelValue(json) {

	window.setTimeout(function () {
		featureInfoDone = true;
	}, 500);

	if (json.features[0].properties.GRAY_INDEX < 255 && json.features[0].properties.GRAY_INDEX != 0) {
		$('#valueTxt').html(Math.round((json.features[0].properties.GRAY_INDEX - 64) / 2) + " dBZ");
	}
	else {
		$('#valueTxt').html(" -  dBZ");
	}
}



function updateRadarInfo(site) {
    var p1 = new LatLon(radars[site].marker.position.lat(), radars[site].marker.position.lng());
    var p2 = new LatLon(metLatitude, metLongitude);
    var d = p1.distanceTo(p2)/1000; 
    $('#radarTxt').html(radars[site].name.toUpperCase()+" ("+radars[site].country.toUpperCase()+")"+"<br/>"+metParameter.toUpperCase()+" &#x29A3; 0 &deg;<br/>&#x2194;"+Math.round(d)+" km \u2195 " + Math.round(100) + "m");
}

function updateClock() {
    var now = new Date();

    var time = [("0" + now.getHours()).slice(-2),
		("0" + now.getMinutes()).slice(-2),
		("0" + now.getSeconds()).slice(-2)].join(':');
    var timezone=String(new Date());
    time = time + " " + timezone.substring(timezone.lastIndexOf('(')+1).replace(')','').trim();

    var utctime = [("0" + now.getUTCHours()).slice(-2),
		   ("0" + now.getUTCMinutes()).slice(-2),
		   ("0" + now.getUTCSeconds()).slice(-2)].join(':') + " UTC";

    var date = [("0" + now.getDate()).slice(-2),
		("0" + (now.getMonth() + 1)).slice(-2),
		("0" + now.getFullYear()).slice(-4)].join('.');

    // set the content of the element with the ID time to the formatted string
    $('#currentTimeTxt').html([date, time, utctime].join('<br/>'));

    // call this function again in 1000ms
    setTimeout(updateClock, 1000);
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
	$('#infoItemPosition').hide();
}

function geoLocationUpdate(location) {
	localStorage.setItem("metLatitude", location.coords.latitude);
	localStorage.setItem("metLongitude", location.coords.longitude);
	metLatitude = location.coords.latitude;
	metLongitude = location.coords.longitude;
	$('#positionTxt').html("&#966; " + Dms.toLat(metLatitude, "dm", 3) + "<br/>" + "&#955; " + Dms.toLon(metLongitude, "dm", 3));
	$('#infoItemPosition').show();
}
