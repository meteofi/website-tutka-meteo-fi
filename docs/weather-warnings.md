# Wind, thunderstorm and rain warnings

## User experience

Open **Varoitukset** in the three-dot menu to select **Ukkosvaroitukset**, **Tuulivaroitukset** and/or **Sadevaroitukset**. The section uses the same collapsible submenu and group switch as **Ilmailu**. The existing `POI_STATE` remembers each selection independently, including selections saved before the submenu was introduced. All three types share one fetch and map layer; the combined summary is **Säävaroitukset**. All panes show the same warning data.

The default **Voimassa nyt** view shows only active warnings. The optional **Seuraavat 24 h** view also includes enabled warning types starting within the next 24 hours. Both use the device's current time, independent of the radar's 13-frame playback window; the sheet states this explicitly.

Yellow / orange / red areas use restrained translucent fills, contrasting boundaries and `!` / `!!` / `!!!` badges. The Finnish legend explains the colors as “Mahdollisesti vaarallinen” (yellow), “Vaarallinen” (orange), and “Hyvin vaarallinen” (red). Future warnings have dashed boundaries. Radar echoes, lightning and observation symbols remain visible. Regional warnings do not describe the exact footprint of a thunderstorm.

A floating summary reports warning areas intersecting the visible map. Tap the summary or a warning area to open a native modal bottom sheet. It has 44 px controls, safe-area padding, keyboard focus containment, Escape/close dismissal, and independent scrolling. Selected overlapping warnings appear first, scrolled below the sticky header. Existing storm cells and marker cards retain tap priority. The list otherwise orders active warnings before upcoming warnings, then by severity and start time.

Card titles follow the guide’s color + hazard format, e.g. “Keltainen tuulivaroitus”, “Oranssi ukkosvaroitus” and “Punainen sadevaroitus”. After the region, active/upcoming state and validity dates with explicit time zones, the warning body is always visible in this order:

1. **Varoitusteksti:** the original CAP description (headline/event only as a fallback if description is absent).
2. **Vaikutukset:** the supplied `impacts` as a bulleted list. MeteoCore exposes this parameter directly; a string or repeated string values are accepted, with pipe-separated items displayed separately. Missing impacts are omitted, never inferred from prose or filled with generic consequences.
3. **Toimintaohje:** the original CAP instruction, using the same heading, spacing and background as the description and impacts sections. Missing instructions are omitted.

Issuer, original language, publication time and the source link follow the body. Original text carries its source language and is inserted as text, not HTML; Finnish section headings have their own language tag. Description/instruction pipe delimiters retain their bullet formatting. Source links accept only HTTP(S). “Näytä alue kartalla” fits the region in the current pane; the shared view moves all panes together. Users can include areas outside the viewport in the list without moving the map.

Loading, empty, failed and stale states are distinct. The UI never presents a successful empty result for an incomplete download. It identifies the source and explains that absence of warning data does not establish absence of hazardous weather.

## Meteoalarm style guide

Presentation follows the relevant sections of the [MeteoAlarm Style Guide v1.0 (February 2026)](https://gitlab.com/meteoalarm-pm-group/documents/-/raw/master/MeteoAlarm_Style_Guide_v1.0.pdf?inline=true): explicit color + hazard titles, visible issuer, start/end time-zone labels, exact source descriptions/instructions and pipe-delimited bullet formatting. Map fills and severity accents use #ffda22, #ff9300 and #ff0000; small text uses lighter tints where needed for contrast on dark surfaces. Wind, lightning and umbrella glyphs are app symbols, not the separately distributed official Meteoalarm icon assets. CAP expires is displayed as supplied; when active_until ends applicability earlier, the sheet shows that separately and filtering honors the earlier end.

## Data and lifecycle

- Endpoint: `https://meteocore.app.meteo.fi/features/collections/cap-meteoalarm-wis2/items`.
- No server-side weather, spatial or temporal filtering is assumed. Fetch pages with `limit=1000`, follow `rel=next`, or use `numberMatched` and `offset` when needed. Reject loops, repeated pages, unexpected next-page origins/paths, malformed responses and incomplete snapshots.
- Keep only structured awareness types **1** (wind), **3** (thunderstorm) and **10** (rain), levels **2–4**, `Actual`, `Public`, `Alert`/`Update`, Polygon/MultiPolygon records. Never infer hazard type from prose. Rain is distinct from flooding (12) and rain-flood (13); those types remain excluded. Codes follow the [Meteoalarm collection metadata](https://api.meteoalarm.org/edr/v1/collections?f=html). Exclude `AllClear`; respect CAP update/cancellation references when present.
- Start is onset, falling back to effective/sent. End is the earlier of expires/active_until. Require a valid positive interval. Start is inclusive, end exclusive. Filter locally before adding features to the map. Distinct CAP feature IDs preserve separate areas/info blocks, including all supplied languages. Equally ranked warnings prefer Finnish, then English; other supplied languages remain available as separate cards.
- One in-memory snapshot, spatial index and request serve every pane. Fetch only while enabled; refresh every five minutes while visible, retry failures after one minute, catch up when the tab returns, and retry on reconnection. Requests time out after 45 seconds and abort on disable. No warning requests are made on pan, zoom, animation or pane creation.
- Replace the source atomically only after every page and geometry has been parsed. Retain the last good snapshot on failure, label it stale, and still expire warnings locally on a 30-second tick. A hidden tab catches up on return. No persistent/offline warning cache is introduced.
- `src/warnings/warningData.js`: CAP transport, normalization and time filter, independently testable.
- `src/weatherWarnings.js`: shared OpenLayers source, cached styles, polling and per-pane hit tests.
- `src/warnings/warningSheet.js`: summary and accessible warning sheet.
- `radar.js` / `pane.js`: import, factory, theme, toggle and click wiring only.

## Vector tiles later

The observed feed on 2026-09-13 was about 105 kB uncompressed for 26 features, so a shared GeoJSON snapshot is a reasonable starting point. Actual cost will grow with warning count and polygon complexity; there is no server-side filter yet.

Vector tiles could reduce polygon transfer and rendering costs at continental scale, but the UI still needs a complete warning metadata index to distinguish “none” from unloaded tiles and to list off-screen warnings. A future API should provide stable feature/alert IDs, severity and validity fields on tiles, plus an independent metadata/detail endpoint and snapshot/version identifier. Tile fragments must resolve to the same warning, including overlapping areas, multilingual info blocks and cancellations. The transport/model boundary allows replacing map geometry loading while keeping the sheet and warning semantics. This has no connection to animated raster WMS: those layers remain ImageWMS.

## Verification

`npm test` includes CAP contract checks for awareness codes, levels, status, all-clear/cancellation, validity boundaries, Polygon/MultiPolygon acceptance, deduplication, safe source links, pagination, repeated pages, partial failures and aborts. Lint and production build are required as usual.

Browser checks use both the live feed and isolated synthetic warnings (never bundled with the application). Cover phone/desktop layout, all severities, current/upcoming filtering, polygon taps and overlaps, original instructions, empty/loading/error/stale/retry, enabling/disabling and persistence, split 2/4 panes, theme switching and warning independence from playback. Check on real iOS Safari before release; desktop mobile emulation cannot reproduce its safe-area/browser-toolbar behavior completely.

Frame trace: first/last radar frame and non-default WMS style/elevation never enter the warning controller. Only the warning's wall-clock interval determines visibility, so scrubbing/playback neither refetches warnings nor changes their validity. Geometry is projected by OpenLayers from GeoJSON longitude/latitude to EPSG:3857; region fitting uses each pane's size with proportional padding so small split panes retain a positive drawable area.
