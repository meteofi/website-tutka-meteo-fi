# Data generators

Every bundled dataset in `src/data/` is a **snapshot**, not a runtime fetch: it
ships as a content-hashed immutable asset, lands in the service-worker precache,
needs no CSP host and has no runtime failure mode. The price is that snapshots
go stale, and these scripts are how they are refreshed.

Run them from the repo root. All are plain node, no build step, no dependencies
beyond node itself.

| Layer | Script | Output | Source | Needs |
|---|---|---|---|---|
| Lentokentät | `fetch-airfields.mjs` | `airfields-finland.geojson` (12 kB) | Finnish eAIP (AD 2) | — |
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
node scripts/fetch-airfields.mjs                      # current AIRAC cycle
node scripts/fetch-airfields.mjs --limit 5            # parse a few, write nothing
node scripts/fetch-airfields.mjs --cycle "003-2026_2026_06_11"
```

**Follows the AIRAC cycle.** The eAIP root lists every cycle as a folder named by
effective date; the script takes the newest whose date has *arrived* — not simply
the newest, since the next cycle is published in advance. The cycle and its
effective date are written into the file's `metadata`, so the snapshot always
says which edition it is.

Re-run **after each AIRAC cycle** (every 28 days) if you care about currency;
aerodromes themselves change rarely.

Fintraffic publishes no data feed, so this **parses HTML**. It is deliberately
loud: fewer than 60 aerodromes, an ARP outside Finland, a missing coordinate or
fewer than 90% carrying an elevation all abort the run rather than write. Use
`--limit` to check the parser after the source changes shape.

Only AD 2 is taken — AD 3 is heliports, mostly hospital pads.

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
