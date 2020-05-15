import { connect as mqttconnect } from 'mqtt';

class AIS {
  constructor(url, username, password, layer) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.layer = layer;
    this.connect();
  }
}

AIS.prototype.connect = function connect() {
  this.client = mqttconnect(this.url, { username: this.username, password: this.password });
};

AIS.prototype.subscribe = function subscribe(vessel) {
  console.log(`Subscribed vessel ${vessel} locations`);
  this.client.subscribe(`vessels/${vessel}/+`);
};

AIS.prototype.track = function track(vessels) {
  this.vessels = vessels;
  Object.keys(vessels).forEach((vessel) => this.subscribe(vessel));
};

AIS.prototype.getVesselName = function getVesselName(mmsi) {
  let name;
  if (typeof this.vessels[mmsi].metadata !== "undefined") {
    name = this.vessels[mmsi].metadata.name;
  } else {
    name = mmsi;
  }
  return name;
};

AIS.prototype.onMessage = function onMessage(topic, payload) {
  let vessel = {};
  let metadata = {};

  if (topic.indexOf('location') !== -1) {
    vessel = JSON.parse(payload.toString());
    this.vessels[vessel.mmsi].location = vessel;
    this.vessels[vessel.mmsi].location.properties.mmsi = vessel.mmsi;
  }

  if (topic.indexOf('metadata') !== -1) {
    metadata = JSON.parse(payload.toString());
    this.vessels[metadata.mmsi].metadata = metadata;
    return;
  }
  /* let format = new GeoJSON({
    dataProjection: 'EPSG:4326',
    featureProjection: "EPSG:3857"
  }); */

  console.log(this.vessels);
  this.layer.getSource().clear(true);
  Object.keys(this.vessels).forEach(function (item) {
    if (typeof this.vessels[item].location !== "undefined") {
      this.layer.getSource().addFeature(format.readFeature(this.vessels[item].location));
      }
    });
    //client.end() */
};

export default AIS;
