# CLAUDE.md

Guidance for Claude Code working in this repository. The **Hard rules** section is non-negotiable — read it before changing any code.

## What this app is

Finnish weather-radar PWA (tutka.meteo.fi). Vanilla JavaScript + OpenLayers 10 + webpack 5. No framework, no TypeScript, no automated tests. All UI text is Finnish — write new UI text in Finnish. Most users are on phones (iOS Safari matters).

The app animates a **13-frame time window** of WMS layers (radar, satellite, lightning, observations) on a map, with optional 1/2/4-pane split screen (panes share one OpenLayers View, so they pan/zoom in lockstep) and optional WebGL optical-flow interpolation between radar frames.

## Commands

| Task | Command |
|---|---|
| Dev server with hot reload → http://localhost:9000 | `npm run dev` |
| Dev server without opening a browser | `npm start` |
| Production build → `dist/` | `npm run build` |
| Lint — must pass with zero errors (airbnb-base) | `npx eslint src/` |

There is no test suite. Verify every change with the checklist at the bottom of this file (the `verify-app` skill walks through it).

Project hooks enforce two rules automatically: commits/pushes on master are blocked, and every edited `src/**/*.js` file is linted on save. If a hook blocks you, fix the cause — do not work around it.

## Hard rules

1. **Never use TileWMS for animated layers** (radar, satellite, lightning, observations). The animation stack (`FramePool` slots, sticky frames, interpolation) requires single-image `ImageWMS` sources. Do not propose tiling, even as an optimization.
2. **Never commit to master.** Start work with `git fetch origin && git checkout -b <topic-branch> origin/master`, push the branch, open a PR. Pushing master deploys production immediately (Firebase). Every PR automatically gets a preview deploy on the `dev-tutka-meteo-fi` Firebase project.
3. **`Map` means different things in different files.** `src/pane.js` has `import { Map } from 'ol'`, so `new Map()` there creates an OpenLayers map. `src/probe.js` and `src/animation/stickyImageWMS.js` use the built-in JavaScript `Map`. Always check the file's imports first.
4. **The animation window is exactly 13 frames** (12 five-minute steps = 1 hour). `FramePool.setWindow` throws on any other length. The constant is duplicated: `13` in `src/radar.js` (several places), `framePool.js` (`size = 13`), `probe.js` (`STRIP_CELLS = 13`); `12` in `crosshair.js` (`WINDOW_FRAMES = 12`). If you change one, audit all of them.
5. **Frames load through `blob:` object URLs** in `StickyImageWMS`. This keeps the canvas untainted, which is why `layer.getData()` works (crosshair pixel readout) and why identical panes share one fetch. Never switch frame loading to plain image URLs.
6. **Changing a WMS source's identity (LAYERS / STYLES / URL / TIME / ELEVATION) must go through the existing update paths that call `invalidateSticky`** — otherwise the next pan repaints the previous product from the sticky cache.
7. **Interpolation hides the real layer by forcing its opacity to 0** (flag `_interpHiding`; true user opacity is kept in `_userOpacity`). UI code listening to opacity changes must skip `_interpHiding` events, and code reading a layer's opacity must prefer `get('_userOpacity')` over `getOpacity()` (see `layerInfoPlaylist` in radar.js) or it captures 0.
8. **Pane 0 is special.** Module-level globals in `radar.js` (`VISIBLE`, `ACTIVE_LAYERS`, `framePools`, `layerss`, …) are aliases of pane 0's state. Only pane 0 persists to localStorage and drives the playlist / layer menus (guards: `isPane0`, `_paneIndex`). Per-pane work must keep these guards intact.
9. **iOS Safari:** `position: fixed` elements need explicit `top`/`bottom` values; safe-area insets are handled with `env(safe-area-inset-*)` in `assets/radar.css`; the split-screen grid must stay `position: static` so it doesn't form a stacking context. Don't "clean up" CSS that looks redundant without checking the iOS notes in comments.
10. **Before pushing visual or coordinate code, trace by hand:** frame index 0, the last frame index, and non-default WMS params. Off-by-one at the window edges is this codebase's most common bug class.

## Module map

Entry point: `src/radar.js` (~3100 lines) — bootstraps panes, owns the shared View, the RAF playback clock (`renderTick`/`play`/`stop`), the `setTime` window math, WMS GetCapabilities polling (60 s), all menus/toolbar/keyboard/theme/geolocation, and wires every other module together via callbacks. It is the app's god module by history, not by design — follow the **radar.js decomposition rules** below.

| Module | Responsibility |
|---|---|
| `src/config.js` | Static registry of WMS servers/layers (pure data; entries with `disabled: true` are off) |
| `src/pane.js` | `createPane()` — one OL map + full layer stack + per-pane state; panes receive the shared View |
| `src/timeline.js` | 13-cell timeline strip UI |
| `src/tools.js` | Measure + point-probe ("pistemittaus") tools; single `activeTool` state machine |
| `src/probe.js` | dBZ point-probe chart via the EDR API; exports shared EDR helpers used by crosshair |
| `src/crosshair.js` | Center reticle readout; reads radar pixels via `getData()` + dBZ via probe helpers |
| `src/radarSite.js` | Single-radar-site drill-in (calls back into radar.js `updateLayer`/`setTime`) |
| `src/longpress.js` | Long-press menu plumbing for toolbar buttons |
| `src/analytics.js` | `track()` wrapper for Umami (no-ops if umami is absent) |
| `src/animation/framePool.js` | `FramePool` — 13 preloaded WMS image slots per (pane, layer), prefetch, sticky swap, interpolator lifecycle |
| `src/animation/stickyImageWMS.js` | `ImageWMS` subclass: keeps last good frame while loading; cross-pane blob cache |
| `src/animation/interpolation/` | WebGL optical flow: `index.js` (`RadarInterpolator`), `flowLK.js`, `warp.js`, `glUtils.js`, `capabilities.js` |

Data flow for playback: RAF `renderTick` (radar.js) → advances `startDate` → `setTime` computes one 13-frame window from the union of all visible layers across active panes → routed per (pane, layer) to each `FramePool.showTime` → pools swap preloaded slots (or `showInterpolated` when interpolation is on).

## radar.js decomposition rules

Shrink radar.js opportunistically; never grow it. There is no scheduled big-bang refactor — these standing rules do the work over time.

1. **New behavior goes in a module, not in radar.js.** Create `src/<feature>.js` (or extend the module that owns the concern): take dependencies as an options object, return an API object, wire it from radar.js — the same pattern as `initTools` / `initProbe` / `createPane`. radar.js may only gain import + wiring lines.
2. **Modules never import radar.js.** No import cycles. Dependencies flow in through the init/deps object; results flow out through caller-provided callbacks. If a module needs `updateLayer` or `setTime`, accept them as callback parameters (see `initRadarSite`) — and prefer intent-named callbacks (`onRequestLayer`) over holding raw radar.js functions.
3. **Touch it → extract it.** If your change substantially modifies one of these concerns, extract the concern to its target module first (or in the same PR), then change it there:
   - GetCapabilities polling + parsing (`getWMSCapabilities`, `getLayers`, `getLayerInfo`, `getTimeDimension`) → `src/wms/capabilities.js`
   - Playlist + layer-selection DOM (`layerInfoPlaylist`, `updateLayerSelection`, `updateLayerSelectionSelected`) → `src/ui/playlist.js`
   - Theme engine (`getEffectiveTheme`, `setMapLayer`, dark-mode handling) → `src/ui/theme.js`
   - localStorage persistence (`safeParseJSON` + all scattered `localStorage` reads/writes, keys listed under State & persistence) → `src/state.js`
4. **Extraction commits are move-only.** Move the code, convert the radar.js globals it used into parameters, wire it up, stop. No behavior changes, no renames, no cleanups in the same commit — put those in a separate commit or PR so the diff stays reviewable.
5. **Pane-0 ownership stays in radar.js.** The pane-0 alias globals (Hard rule 8) and the RAF clock are not extraction targets; extracted modules receive state as parameters, they never own it.
6. **One extraction per PR**, verified with the full finish checklist including the 2/4-pane smoke test — radar.js concerns share hidden state, and small PRs keep regressions bisectable.

## Data sources

Active servers (see `src/config.js` for the full registry): `meteocore.app.meteo.fi/wms` (Finnish + European radar composites — the primary radar source), `wms.meteo.fi` (DBZ/rain-rate products), `wms-obs.app.meteo.fi` (weather observations), `view.eumetsat.int` (satellite RGB products, MTG lightning, RDT). The probe/crosshair read values from the EDR API at `meteocore.app.meteo.fi/edr` (CoverageJSON). Entries marked `disabled: true` (openwms.fmi.fi, Environment Canada, KNMI, …) are inactive — don't document or build on them.

## State & persistence

- localStorage keys: `metPosition`, `metZoom`, `VISIBLE`, `ACTIVE_LAYERS`, `interpMode`, `IS_DARK`, `IS_TRACKING`, `IS_FOLLOWING`, `LP_HINT_SEEN`, `POI_STATE`, `timeIsUtc` (+ legacy `metLatitude`/`metLongitude` writes). JSON values go through `safeParseJSON` in radar.js.
- Map center/zoom also syncs to the URL hash via `ol-hashed`.
- `IS_FOLLOWING` (auto-advance to newest frame) is derived in `setTime`; the 60 s GetCapabilities refresh calls `setTime('last')` while following.

## Deployment

- GitHub Actions: PR → build + preview deploy (`dev-tutka-meteo-fi`); push to master → production deploy (`tutka-meteo-fi`, Firebase Hosting). A Docker/nginx build also exists (`Dockerfile`).
- Service worker (Workbox `GenerateSW`, production builds only) uses `skipWaiting` + `clientsClaim` deliberately — read the long comment in `webpack.config.js` before touching SW config.
- `assets/` is copied verbatim into `dist/`; hashed JS bundles are cache-immutable, HTML/JSON are no-cache (`firebase.json`).

## Checklist before you finish any change

1. `npx eslint src/` → zero errors.
2. `npm run build` → succeeds.
3. Exercise the changed feature in the running app (dev server) — including split-screen (2 and 4 panes) if you touched panes, layers, timing, playback, or interpolation.
4. Hard rule 10: trace index 0 / last index / non-default params for visual or coordinate changes.
5. Work is on a topic branch with a PR — never on master.
