# Data generators

Every bundled dataset in `src/data/` is a **snapshot**, not a runtime fetch: it
ships as a content-hashed immutable asset, lands in the service-worker precache,
needs no CSP host and has no runtime failure mode. The price is that snapshots
go stale, and these scripts are how they are refreshed.

Run them from the repo root. All are plain node, no build step, no dependencies
beyond node itself.

| Layer | Script | Output | Source | Needs |
|---|---|---|---|---|
| Lentokentät | `fetch-airfields.mjs` | `airfields-finland.geojson` (12 kB), `airfields-france.geojson` (23 kB), `airfields-switzerland.geojson` (9 kB) | Finnish + French eAIP (AD 2), Swiss from openAIP | — |
| Ilmatilat | `fetch-airspace.mjs` | `airspace-finland.geojson` (254 kB) | openAIP export | — |
| Nimistö | `fetch-placenames.mjs` | `placenames-fi.geojson` (1.2 MB) | MML place names | `MML_API_KEY` |
| Rautatiet — asemat | `fetch-rail-stations.mjs` | `railway-stations-finland.geojson` (27 kB) | Digitraffic rail | — |
| Rautatiet — raiteet | `fetch-rail-tracks.mjs` | `railway-tracks-finland.geojson` (303 kB) | Väylä OGC API | — |
| Käännöspisteet | `convert-turnpoints.mjs` | `turnpoints-finland.geojson` (96 kB) | local `.cup` file | the CUP file |

After any run: `npx eslint src/` and `npm run build`, then look at the layer in
the app. A snapshot that parses is not the same as a snapshot that is right.

## Per script

### `fetch-airfields.mjs` — aerodromes

```sh
node scripts/fetch-airfields.mjs                      # both countries, current cycle
node scripts/fetch-airfields.mjs --country fr         # just one
node scripts/fetch-airfields.mjs --limit 5            # parse a few, write nothing
node scripts/fetch-airfields.mjs --country fi --cycle "003-2026_2026_06_11"
node scripts/fetch-airfields.mjs --country fr --cycle 2026-08-06
```

**Two countries, one file each**, because each follows its own AIRAC cycle and
carries its own attribution. The shared machinery is the fetching and the
refuse-to-write checks; a country adapter knows how to find its cycle, list its
aerodromes and read one of its pages.

**Follows the AIRAC cycle.** Finland's eAIP root lists every cycle as a folder
named by effective date, and the script takes the newest whose date has
*arrived* — not simply the newest, since the next cycle is published in advance.
France publishes no such index, so the cycle date is derived from the 28-day
AIRAC series and the folder probed, stepping back a cycle if the newest is not
published yet. The cycle and its effective date go into each file's `metadata`,
so a snapshot always says which edition it is.

Re-run **after each AIRAC cycle** (every 28 days) if you care about currency;
aerodromes themselves change rarely. France only keeps the current and previous
cycles online, so `--cycle` cannot reach further back than that.

Neither authority publishes a data feed, so this **parses HTML**. It is
deliberately loud: too few aerodromes, an ARP outside the country, a missing
coordinate, fewer than 90% carrying an elevation or nowhere naming a MET office
all abort the run rather than write. Use `--limit` to check the parser after a
source changes shape.

Only AD 2 is taken — AD 3 is heliports, mostly hospital pads. France's AD 2 has
three subsections and all are taken: civil IFR, the one civil VFR field with
heliport IFR procedures, and the 22 military aerodromes.

**The `metar` flag is a per-country decision, and it was measured.** In Finland,
AD 2.11's associated MET office predicts exactly which aerodromes answer met.no;
in France it does not (135 name an office, 85 of those answer, and one that names
none answers anyway), so every French AD 2 aerodrome is flagged and the METAR
source narrows to whoever replies. Switzerland has no MET office field at all,
but its openAIP *type* turns out to predict it almost exactly: 16 of the 17
IFR-capable and major aerodromes report, 0 of the 43 glider and VFR-civil ones
do, so the type is the flag and it wastes one code rather than 44.

### openAIP instead of an eAIP, and what it costs

Switzerland comes from openAIP because Skyguide publishes no eAIP a script can
read. Measured against France, where both sources exist (2026-08-25):

| | |
|---|---|
| ICAO coverage | openAIP knew all 141 French AD 2 aerodromes, plus 9 more (mostly military) |
| position | **not the ARP** — median 154 m away, p90 649 m, worst 1.7 km (LFOK) |
| elevation | median agrees to 1 ft, but 38 of 141 differ by >20 ft, up to 154 ft (LFKC 210 vs 56) |
| currency | **no AIRAC cycle recorded at all**; half the French records last touched 2024 or earlier |

So: eAIP where one can be read, openAIP where it cannot, and the Swiss file's
own `note` says its positions are not published reference points. Good enough to
put a marker and a code on a weather map; not good enough to plan a flight with.

**openAIP is CC BY-NC**, unlike the eAIP sources, so the aerodrome layer's credit
is now a licence condition — the same constraint the airspace layer carries.

### `fetch-airspace.mjs` — airspace

```sh
node scripts/fetch-airspace.mjs
```

**CC BY-NC 4.0.** The only non-commercial dataset in the app; everything else is
plain CC BY. The credit is a licence condition, not a courtesy.

openAIP's download page hands out a presigned S3 link that expires in 24 hours,
but the same object answers without any signature parameters, so the script uses
the stable URL and needs no key.

**It records no AIRAC cycle**, which is why aerodromes come from the eAIP
instead: openAIP's Finnish airspace is largely a June 2025 snapshot. There is no
schedule to follow here — re-run occasionally and diff.

Aborts on an airspace `type` it does not recognise rather than letting one
silently vanish from the map. If that happens, identify the new type from the
names in the export and add it to `TYPES`.

### `fetch-placenames.mjs` — place names

```sh
node --env-file=.env scripts/fetch-placenames.mjs
```

Needs a free personal **`MML_API_KEY`**, kept in the gitignored `.env`. The key
is needed *only* here — the app never talks to MML at runtime.

Coverage stops at the Finnish border; European labels are an open gap.

### `fetch-rail-stations.mjs` / `fetch-rail-tracks.mjs` — railway

```sh
node scripts/fetch-rail-stations.mjs
node scripts/fetch-rail-tracks.mjs
```

No keys. Stations keep only `passengerTraffic: true` — the places trains
actually stop for people, not freight yards and lineside turnouts.

gzip is **mandatory** across Digitraffic: a request without `Accept-Encoding:
gzip` is answered HTTP 406. `fetch` always sends it; this only bites hand-rolled
`curl` checks.

### `convert-turnpoints.mjs` — gliding turnpoints

```sh
node scripts/convert-turnpoints.mjs [in.cup] [out.geojson]
```

The only one with no network source: it converts the **checked-in**
`turnpoints-finland.cup` (SeeYou/Naviter format, from Ilmailuliitto). To update,
replace the `.cup` file and re-run.

## Tests

Not generators, but they live here for the same reason the generators do: plain
node, no build step, no dependencies.

```sh
npm test          # -> node scripts/test-all.mjs
```

`test-all.mjs` runs every `scripts/test-*.mjs` and `scripts/test-*.sh`.
**Adding a test is adding a file** — it is discovered by name, no package.json
edit. It also runs all of them even when one fails, then names the failures; a
runner that stops at the first one hides how much else broke.

| File | Pins |
|---|---|
| `test-peaks.mjs` | `src/edr/peaks.js` — the peak-per-frame rule |
| `test-series-fetch.mjs` | `src/edr/seriesFetch.js` — request/window bookkeeping |
| `test-protect-master.sh` | `.claude/hooks/protect-master.sh` — the push guard |

**Why only these are tested**, when nothing else in the repo is: in each case
every way the code can break is **silent**. A wrong answer does not throw. The
probe chart and the crosshair readout must agree about every point on the map
and previously agreed by hand-copying the rule (issue #126) — get it wrong and
you draw a different number under the reticle than in the chart, hide a real
0 dBZ echo as "no data", or briefly show the value from wherever you just panned
away. The push guard is a regex over a shell command string, and a pattern it
misses does not error either; it just permits the push. Lint, build and a
browser smoke test pass straight through every one of those.

That is the bar for adding a test here — "failure is invisible" — not "this file
is important".

What they cover: exact-0 against a floor of 0, signed moments where
largest-magnitude and largest-value disagree, off-grid and half-step rounding,
out-of-window either side, index 0 and index 12, degenerate inputs — and for the
fetch slot, that a superseded request is dropped rather than allowed to repaint
fresh UI.

Both were checked against a deliberately broken implementation to confirm they
actually fail. A test that cannot fail is worse than no test.

The `--disable-warning` flag the runner passes to each file silences
`MODULE_TYPELESS_PACKAGE_JSON`, raised because the modules under test are ESM in
`.js` files. Do **not** "fix" that by adding `"type": "module"` to package.json —
`webpack.config.js` is CommonJS and the build would stop working.

## Not generated by anything

`src/data/radars-finland.geojson` (19 radar sites) has **no script**. It is the
fallback used when the WMS GetCapabilities poll cannot supply the site list, and
it carries fields no upstream publishes in one place — `coverage_radius_m`,
`elevation_angles`, `quantities`, the MeteoCore `collection` name. It is
maintained by hand; edit it directly when a site is added or its capability
changes.
