# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Finnish weather radar web application (tutka.meteo.fi) — a PWA that displays weather radar, satellite imagery, lightning data, and weather observations on an interactive map. Built with OpenLayers and vanilla JavaScript. UI language is Finnish.

## Build & Development Commands

- `npm run dev` — start dev server with hot reload (opens browser at localhost:9000)
- `npm start` — start dev server without auto-open
- `npm run build` — production build to `dist/`
- `npm run watch` — watch mode (no dev server)
- Linting: ESLint with airbnb-base config (`.eslintrc`)

## Architecture

**Entry point:** `src/radar.js` — single large module (~700 lines) containing all map setup, layer management, animation logic, UI event handlers, and WMS configuration.

**Key modules:**
- `src/radar.js` — OpenLayers map with multiple WMS data sources (FMI, EUMETSAT, Environment Canada), animation/playback system for time-series radar data, geolocation, keyboard shortcuts
- `src/timeline.js` — Timeline UI component for the animation playback bar
- `src/digitraffic.js` — AIS vessel tracking via MQTT (Digitraffic API)
- `src/index.html` — SPA shell with toolbar, info panel, layer controls, and long-press menus

**Data sources (WMS servers):**
- FMI (openwms.fmi.fi) — Finnish radar composites
- Meteo.fi (wms.meteo.fi) — DBZ/rain rate radar products
- Meteo.fi (wms-obs.app.meteo.fi) — weather observations
- EUMETSAT (view.eumetsat.int) — satellite imagery (HRV, convection, natural color)
- Environment Canada (geo.weather.gc.ca) — Canadian radar

**Static assets:** `assets/` directory is copied to `dist/` at build time. Contains `radar.css`, `manifest.json`, radar station locations (`radars-finland.json`), and PWA icons.

## Deployment

- Firebase Hosting — auto-deploys on push to `master` via GitHub Actions
- Docker build also available (`Dockerfile` — multi-stage with nginx)
- Build output goes to `dist/`

## State Management

Map state (position, zoom, active layers, visible layer categories) is persisted to `localStorage`. The `ol-hashed` library syncs map center/zoom to the URL hash.
