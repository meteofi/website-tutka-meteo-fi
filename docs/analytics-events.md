# Analytics events

Reference for every Umami event emitted by tutka.meteo.fi.

All events flow through `track()` in `src/analytics.js`, which is a thin guard around the global `umami.track()` injected by the script tag in `src/index.html`. Call sites live in `src/radar.js`. The four content categories also use `trackCategory()` (radar.js) which maps an OpenLayers layer name to a headline event name.

> **Naming convention:** events are kebab-case nouns or noun-verbs. Property values go in props, not in the event name (one exception: the four content-category events are named after the category itself so they show up at the top of the Umami dashboard without filtering).

---

## Event catalog

| Event | Fires when | Cardinality |
|---|---|---|
| [`app-boot`](#app-boot) | Once per page load, after the interpolation probe resolves | 1× per session |
| [`pwa-installed`](#pwa-installed) | Browser fires `appinstalled` | rare, lifetime once per device |
| [`theme-change`](#theme-change) | User picks light/dark/auto, or OS flips while in auto | per user action |
| [`interp-mode`](#interp-mode) | User picks an interpolation mode chip in the overflow menu | per user action |
| [`time-chip-toggle`](#time-chip-toggle) | User taps the bottom-left clock to toggle UTC vs local | per user action |
| [`tracking-on`](#tracking-on--tracking-off) / [`tracking-off`](#tracking-on--tracking-off) | User taps the geolocation FAB | per user action |
| [`poi-toggle`](#poi-toggle) | User toggles a POI category in the overflow menu | per user action |
| [`satellite`](#content-category-events) · [`radar`](#content-category-events) · [`lightning`](#content-category-events) · [`observation`](#content-category-events) | User toggles visibility, picks a sublayer, or picks a style for that category | per user action |

---

## `app-boot`

Single boot event. Replaces the older `interp-boot` + `app-display` + `version` trio.

| Prop | Type | Values | Source | Notes |
|---|---|---|---|---|
| `display-mode` | enum | `browser` · `standalone` · `fullscreen` · `minimal-ui` | `window.matchMedia('(display-mode: …)')` | PWA install indicator. `standalone` ≈ installed PWA. |
| `theme-pref` | enum | `auto` · `light` · `dark` | `localStorage.IS_DARK` (`null` → `auto`, `true` → `dark`, `false` → `light`) | The user's stored choice. |
| `theme-shown` | enum | `light` · `dark` | `getEffectiveTheme()` — resolves `auto` via `prefers-color-scheme` | What's actually rendered this session. |
| `radar-visible` | bool | `true` · `false` | `VISIBLE.has('radarLayer')` (`localStorage.VISIBLE`) | Visibility preference at boot. Default `true` on first visit. |
| `satellite-visible` | bool | `true` · `false` | `VISIBLE.has('satelliteLayer')` | Default `false`. |
| `lightning-visible` | bool | `true` · `false` | `VISIBLE.has('lightningLayer')` | Default `false`. |
| `observation-visible` | bool | `true` · `false` | `VISIBLE.has('observationLayer')` | Default `false`. |
| `interp-capable` | bool | `true` · `false` | `canInterpolate()` probe | `false` = device/browser can't run interpolation. |
| `interp-mode` | enum | `off` · `crossfade` · `flow` | `localStorage.INTERP_MODE_KEY`, falls back to default if not capable | What's running this session. Project default is `off`. |
| `interp-error` | bool (optional) | `true` only — omitted on success | `canInterpolate().catch` branch | Probe threw, distinct from honest `false`. |
| `build-date` | string | ISO date, e.g. `2026-04-28` | `BUILD_DATE` build constant | Split metrics by deploy. |
| `ol-version` | string | semver, e.g. `10.6.1` | `OL_VERSION` from `ol/util` | Correlate regressions with library upgrades. |

**Reading guide**

| Question | Filter |
|---|---|
| % installed as PWA | `display-mode = standalone` |
| Theme choice distribution | breakdown of `theme-pref` |
| Of auto users, what does the OS prefer? | `theme-pref = auto` → breakdown of `theme-shown` |
| Visibility prefs per category | breakdown of `*-visible` |
| Interpolation adoption | `interp-mode = crossfade \| flow` (out of `interp-capable = true`) |

---

## `pwa-installed`

Fires when the browser dispatches `appinstalled` (the PWA was installed during this session). No props. Distinct from `app-boot.display-mode = standalone`, which counts every standalone *visit*.

---

## `theme-change`

Fires from two paths: explicit user toggle in the overflow menu, and OS color-scheme flip while pref is `auto`.

| Prop | Type | Values | Notes |
|---|---|---|---|
| `pref` | enum | `auto` · `light` · `dark` | The user's stored choice after the change. |
| `shown` | enum | `light` · `dark` | What's now rendered. |

OS-driven changes always carry `pref: 'auto'`.

---

## `interp-mode`

Fires when the user picks an interpolation chip in the overflow menu.

| Prop | Type | Values |
|---|---|---|
| `mode` | enum | `off` · `crossfade` · `flow` |

Disabled chips (when `interp-capable = false`) cannot fire this event.

---

## `time-chip-toggle`

| Prop | Type | Values |
|---|---|---|
| `utc` | bool | `true` (now showing UTC) · `false` (now showing local) |

---

## `tracking-on` / `tracking-off`

Geolocation FAB. No props. Two separate event names (legacy split — could be merged into one `geo-tracking { on: bool }` event later if needed).

---

## `poi-toggle`

Overflow-menu POI rows (radar stations, lightning stations, etc.).

| Prop | Type | Values |
|---|---|---|
| `id` | string | POI registry id, e.g. `radars-finland` |
| `visible` | bool | `true` · `false` (state after the toggle) |

---

## Content-category events

Four headline events — one per top pill button — covering visibility toggles, sublayer picks, and style picks. Naming the events after the category (instead of one generic `layer` event) makes the four primary navigation items appear at the top of the Umami dashboard without filtering.

### Events

| Event | Category | OL layer name |
|---|---|---|
| `satellite` | satellite imagery | `satelliteLayer` |
| `radar` | weather radar | `radarLayer` |
| `lightning` | lightning strikes | `lightningLayer` |
| `observation` | weather observations | `observationLayer` |

All four share the same prop schema.

### Props

| Prop | Type | Values | Present when |
|---|---|---|---|
| `action` | enum | `toggle` · `pick` · `style` | always |
| `visible` | bool | `true` · `false` (state after the toggle) | `action = toggle` |
| `layer` | string | WMS LAYERS id | `action = pick` |
| `style` | string | WMS STYLES name | `action = style` |
| `source` | enum | `button` · `key` · `playlist` · `longpress` | always |

### Action reference

| Action | Replaces legacy event | Meaning |
|---|---|---|
| `toggle` | `layer-visibility` | Visibility flipped on or off |
| `pick` | `layer-switch` | Sublayer (WMS LAYERS) changed |
| `style` | `layer-style` | Style/palette (WMS STYLES) changed |

### `source` reference

| Value | Origin in code |
|---|---|
| `button` | Pill button short-tap (radar.js:1487, 1496, 1505) and lightning button click (1476) |
| `key` | Number-key shortcut 1–4 (1718–1724) |
| `longpress` | Long-press menu sublayer pick (1488, 1497, 1506) |
| `playlist` | Eye icon, card title bar, layer-select list, style chip (1383, 1472, 1480, 1755, 1192) |

### Example payloads

```json
{ "event": "satellite",   "action": "toggle", "visible": true,  "source": "button" }
{ "event": "radar",       "action": "pick",   "layer": "fmi-radar-composite-dbz", "source": "longpress" }
{ "event": "radar",       "action": "style",  "style": "radar-rr",   "source": "playlist" }
{ "event": "lightning",   "action": "toggle", "visible": false, "source": "key" }
{ "event": "observation", "action": "pick",   "layer": "observation:airtemperature", "source": "playlist" }
```

### Known sublayer values

These are bounded sets at the time of writing — useful for sanity-checking dashboard breakdowns. Names come from the WMS GetCapabilities responses and may grow.

| Category | Common WMS LAYERS values |
|---|---|
| `satellite` | `msg_iodc:hrv_clouds`, `mtg:airmass`, `mtg:natural_color`, `mtg:convection`, … (EUMETSAT) |
| `radar` | `fmi-radar-composite-dbz`, `Radar_1km_RR`, `Radar_1km_SRI`, … (FMI / Meteo.fi) |
| `lightning` | `observation:lightning` |
| `observation` | `observation:airtemperature`, `observation:rh`, `observation:windspeedms`, … (FMI obs) |

### Known style values

Style names are layer-specific and mostly come from the WMS server. Examples:

| Category | Example STYLES |
|---|---|
| `radar` | `radar-rr-color`, `dbz-fmi`, `dbz-eureffin` |
| `satellite` | server defaults, occasionally overridden |
| `observation` | parameter-specific palettes |

---

## Dashboard cookbook

### Top of dashboard at a glance

The four content-category events appear ordered by frequency, so the main events list reads like:

```
radar          12,400
satellite       3,890
lightning         640
observation       210
```

That's already the answer to "which categories are most used."

### How many users have satellite enabled at boot?

`app-boot` → property breakdown on `satellite-visible`. The `true` slice is the satellite-by-default cohort.

### Most-picked radar sublayer this week

`radar` → filter `action = pick` → breakdown by `layer`.

### How do users discover styles?

`radar` (or any category) → filter `action = style` → breakdown by `source`. Heavy `longpress` indicates the long-press menu is the discovery path; heavy `playlist` indicates users prefer the layer card.

### Are keyboard shortcuts used?

Any of the four category events → breakdown by `source`. Compare `key` slice across categories.

### Did the user actually see dark mode?

`app-boot` → filter `theme-pref = auto` → breakdown by `theme-shown`. Add `theme-change` with `pref = auto` to capture mid-session OS flips.

---

## Cardinality notes

Umami stores property values as strings. For each prop, the set of distinct values it can take affects how readable breakdowns are.

- **Bounded enums** (`action`, `source`, `display-mode`, `theme-*`, `interp-mode`, `mode`): tiny, always safe.
- **Bounded strings that change at deploy** (`build-date`, `ol-version`): small, safe.
- **WMS-derived strings** (`layer`, `style`, POI `id`): bounded by what the WMS servers expose. Currently low tens of distinct values per category; safe but worth re-checking after major data-source additions.
- **Booleans** (`*-visible`, `visible`, `utc`, `interp-capable`, `interp-error`): trivial.

No prop carries map coordinates, search terms, or anything that could fingerprint a user.

---

## Adding a new event

1. Pick a name. Headline categories use the category name; everything else uses kebab-case noun-verb (e.g. `tool-measure`).
2. Decide if it slots into an existing event with a new `action` value (preferred for related actions on the same surface) or earns a new event name.
3. Import `track` from `./analytics` (or use `trackCategory` for the four categories).
4. Add an entry to this document — props, values, sources.
5. If it touches a permission boundary (geolocation, camera, etc.) double-check no PII is in the props.

## Removing or renaming an event

Umami won't merge historical data with a new name. Either:

- Accept a clean break and pick a cutover date.
- Or run both names for one cycle and remove the old one once the dashboard catches up.

Removing a tracked-but-unread event is free — clear it out instead of letting it rot.
