const wmsServerConfiguration = {
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
};

export default wmsServerConfiguration;
