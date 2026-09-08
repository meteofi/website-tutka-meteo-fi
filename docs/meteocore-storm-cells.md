# MeteoCore storm cells — reference for LLM consumers

For a model reading MeteoCore's tracked storm-cell layer: plotting it in this
repo, or describing the weather situation in text.

This is a contract, not a suggestion. The failure mode it prevents is a
**fluent, confident sentence the data does not support** — a `null` read as
zero, a ranking read as a warning, a ground echo read as a storm.

Verified against the production server on 2026-09-08 (MeteoCore `main` at
#660). When this document and the server disagree, the server is right and
this document needs a PR.

---

## 1. What it is

Every 5 minutes MeteoCore segments the FMI radar composite at 35 dBZ into
tracked cells, carries their identity across frames, and computes per cell:
radar attributes, lifecycle, motion quality, nearest-radar beam geometry,
lightning attribution, impact context, and a composite **significance** score
with the reasons behind it.

Cells are **analysis only** — observed frames, never forecast positions. The
same collection also serves motion-extrapolated *raster* imagery to 2 h ahead;
that is a different product and has no cells.

## 2. Access

```
GET https://meteocore.app.meteo.fi/features/collections/fmi-radar-nowcast/items
```

GeoJSON `FeatureCollection`, `Point` geometry, CRS84 (`[lon, lat]`). Feature
`id` is the track id as a string.

| Parameter | Values | Notes |
|---|---|---|
| `limit` | 1–1000 | A whole frame is a few hundred cells at most; `limit=1000` fetches it all |
| `sortby` | `-significance`, `+max_dbz`, … | `-` descending, `+` ascending. Any property in the collection's `sortable_properties`; anything else is **HTTP 400** naming the valid ones |
| `bbox` | `west,south,east,north` | WGS84, filters on the centroid |
| `datetime` | RFC 3339 instant or `start/end` | The frame at that instant, or the newest retained frame inside the interval. Future instants return **0 features** |
| `offset` | ≥ 0 | Paging |

The current situation, most significant first:

```
/items?sortby=-significance&limit=1000
```

One animation frame (pass the frame instant, 5-minute aligned):

```
/items?datetime=2026-09-08T06:10:00Z&sortby=-significance&limit=1000
```

Responses carry `ETag` and `Cache-Control: public, max-age=60`; send
`If-None-Match` and expect `304`. Data changes every 5 minutes, so polling
faster than 60 s yields nothing.

**Sorting and rank agree.** `sortby=-significance&limit=N` returns exactly
ranks 1…N (MeteoCore #644). Earlier a limited page could hold ranks 1–29
then 31; that is fixed and the caveat can be dropped.

**Retention** is the last ~4 h of frames (48 at 5 min) and **empties on a
server restart** — every track then restarts at `track_age: 1` and ids restart
from 1. Read the retained span from the collection's `extent.temporal` (or the
MCP `retained_frames`) rather than assuming it.

### MCP

The same cells are available to a model over MCP (`/mcp`, bearer token):
`list_collections`, `get_collection_info` (tracked count, retained span,
`sortable_properties`), `get_storm_cells` (`at`, `limit` ≤ 50, `sort_by`,
`order`, `min_significance`) and `get_cell_track` (one cell's history, newest
first). Known limit: `get_cell_track` can answer "not present in any retained
frame" for a cell that died before the newest frames when the walk budget runs
out (MeteoCore #646) — treat that note as "not found within the walk", not as
proof the cell never existed.

## 3. Fields

All inside `properties`. Everything except `id`, `observed`, `severity`,
`max_dbz`, `area_km2`, `track_age`, `significance*`, `likely_clutter` and
`volume_trend`'s presence may be `null`; see §6 for what a `null` means.

### Radar and lifecycle

| Field | Unit | Meaning |
|---|---|---|
| `severity` | — | `weak` \| `moderate` \| `severe` \| `very_severe` — see §5 |
| `max_dbz`, `area_km2` | dBZ, km² | Peak composite reflectivity; footprint above 35 dBZ |
| `observed` | RFC 3339 | Analysis instant of this frame |
| `track_age` | frames | 1 = first seen. Frames, not minutes (5-min cadence) |
| `volume_trend` | — | `growing` \| `decaying` \| `null` (too new, or change inside the deadband). Hysteretic, so it does not flap frame to frame |
| `intensity_trend_dbz_min` | dBZ/min | Signed, smoothed, clamped to ±0.4 (the tracker's own cap). `null` until the second frame |

### Motion and track quality

| Field | Unit | Meaning |
|---|---|---|
| `speed_ms`, `bearing_deg` | m/s, ° | Ground speed; compass bearing moved **toward**. `null` until the second frame |
| `net_displacement_km` | km | Straight-line distance from where the track was first seen. Cannot be inflated by an association mistake, unlike `track_age` |
| `path_straightness` | 0–1 | Net ÷ path-integrated distance. **~1 = real advection, ≲0.4 = a track wandering without arriving.** `null` while the path is under 1 km |
| `deviant_mover` | bool | Sustained motion ≥ 5 m/s off the ambient flow over 2+ frames, on a coherent track. `null` until there is a velocity |
| `likely_clutter` | bool | Persistent near-stationary echo (speed < 3 m/s for ≥ 6 frames, and not travelled > 3 km net). Never `null` — but `false` means *not yet demonstrated*, see §4 |

### Nearest-radar beam geometry (MeteoCore #658)

| Field | Unit | Meaning |
|---|---|---|
| `nearest_radar_id`, `nearest_radar_name` | — | Nearest site by great-circle distance (ODIM NOD code, e.g. `fivih`) and its place name |
| `nearest_radar_distance_km` | km | From that radar to the centroid |
| `in_radar_coverage` | bool | Inside that radar's surveyed range. **`null` = the site advertised no range ("cannot say"), which is not "not covered"** |
| `beam_height_m` | m | Centre of the lowest sweep over the cell, **above mean sea level** — there is no terrain model. Present only inside coverage and within the lowest sweep's own range; otherwise `null` |
| `beam_elevation_deg` | ° | That lowest sweep's tilt. Same presence rule |

All six exist only because the collection has a radar source wired; they are
all `null` together for a frame in which the radar catalog was empty.

### Lightning (present only with a lightning source wired — it is)

| Field | Unit | Meaning |
|---|---|---|
| `flash_count`, `flash_rate_per_min`, `flash_density_per_km2` | strikes, 1/min, 1/km²/min | Since the previous frame |
| `ic_count`, `cg_count` | counts | Intra-cloud / cloud-to-ground split. `0` with `flash_count: 0`; `null` only when the network reported no discriminator |
| `cg_polarity_known`, `positive_cg_fraction` | count, 0–1 | CG flashes with a known polarity, and the positive share of those. Fraction is `null` with no classifiable CG flashes (0/0 is not 0 %) |
| `first_flash` | RFC 3339 | First flash on this track, **ever** — with `flash_count: 0` it means "flashed earlier, quiet now" |
| `lightning_jump`, `jump_sigma` | bool, σ | Schultz-style 2σ flash-rate jump and its magnitude. Both `null` until two prior frames give a baseline |

### Impact (present only with an impact source wired — it is, Finnish municipalities)

| Field | Unit | Meaning |
|---|---|---|
| `impact_over` | — | Municipality under the **centroid**. `null` = sea or outside Finland (measured) |
| `impact_approaching` | — | First *different* municipality the centroid reaches along its motion within 60 min. `null` with no velocity, or none ahead |
| `impact_eta_minutes` | min | Time to that municipality's **boundary**, in 2-minute steps — not to its town centre (MeteoCore #622) |

### Significance

| Field | Unit | Meaning |
|---|---|---|
| `significance` | 0–1 | The ranking score, 4 decimals — see §5 |
| `significance_rank` | int | 1-based, **within this frame** |
| `significance_reasons` | string[] | Up to 3 terms that moved the score most, strongest first. **Two of the possible names are demotions:** `clutter` and `weakening` mean the cell ranked *lower* because of them. The rest (`severity`, `max_dbz`, `area`, `impact`, `intensifying`, `deviant_mover`, `lightning_jump`, `flash_rate`, `positive_cg`) promoted it |

`sortable_properties` on the collection lists what `sortby` accepts: every
numeric or boolean field above except `severity` (as a string it would sort
`moderate < severe < very_severe < weak`).

## 4. Clutter — read this before plotting anything as a storm

Wind farms, masts and anomalous propagation produce bright, compact,
stationary echoes that score high on *every* intensity term. The server does
not remove them: it flags and demotes, and a first-frame detection is
indistinguishable from a new pulse storm on radar alone.

**`likely_clutter: false` does NOT mean meteorological.** It means "not yet
demonstrated otherwise": the test needs 6 frames of history, so after every
server restart nothing can be flagged for half an hour.

Read these together, in this order:

1. `likely_clutter: true` → a persistent stationary echo. Do not present it as
   weather. (Also demoted: `clutter` leads its `significance_reasons` and the
   score keeps a tenth of what it would otherwise be.)
2. `beam_height_m` of a few hundred metres, `speed_ms` under ~3 and
   `net_displacement_km` under ~1 on a bright cell → the wind-farm signature.
   This works on the **first frame**, which the flag cannot judge. Say
   "todennäköisesti häiriökaiku", not "ukkossolu".
3. `path_straightness` ≲ 0.4 with a small `net_displacement_km` → a track
   that wanders without arriving, usually two fixed echoes sharing one id.
   Treat its speed and bearing as noise.
4. `track_age` is **not** evidence of a real storm; an association mistake
   can manufacture a long track out of stationary echoes. Displacement is.

Live example, 2026-09-08 06:10Z, right after a restart: the two top-ranked
cells were `very_severe` 55.5 dBZ at 26.98E 62.40N (rank 1, speed 1.1 m/s,
net 0.3 km, beam 741 m, Kuopio) and `severe` 53.5 dBZ at 26.07E 65.31N (rank
2, speed 2.1 m/s, net 0.6 km, beam 651 m, Utajärvi). Both are sites that
recur under fresh ids for hours at a time; both were `likely_clutter: false`
at `track_age: 2`. Rule 2 catches them; rule 1 catches them half an hour
later.

## 5. severity vs significance

Different questions; the disagreement carries information.

**`severity`** — radar only. One point each for `max_dbz` ≥ 45, ≥ 50, ≥ 55
and `area_km2` ≥ 50; 0 → `weak`, 1 → `moderate`, 2 → `severe`, 3–4 →
`very_severe`. Rising is immediate; falling needs the peak to clear the step
by a deadband, so a cell parked at a boundary does not flap. On an active day
most of the top of the list is `very_severe`, where the label stops
discriminating. It is a reflectivity class, not a hazard assessment: a
bright band or a wind farm earns it too.

**`significance`** (MeteoCore #645) — a weighted mean of the *graded* terms
(severity, max_dbz, area, flash_rate, positive_cg, impact; `impact` has the
largest weight, so a moderate cell over a town outranks a very severe one
over sea), with signals composed on top and the total bounded to 0–1 by
construction:

- `intensifying`, `deviant_mover` and `lightning_jump` each fill part of the
  remaining headroom; several at once cannot push a cell past 1.0;
- `clutter` removes 90 % of the score, `weakening` up to 15 %.

A signal that did not fire contributes nothing and dilutes nothing, so an
ordinary unflagged cell can reach the top of the range (before #645 it was
capped near 0.5). A steady cell has no trend term at all.

Rules:

- **Compare ranks within a frame, never scores across frames or days.**
  Graded terms with no data drop out, so absolute scores shift.
- **Rank is per-frame**, not a property of the storm.
- **Ranks compress at high cell counts.** Below roughly rank 10 on a
  widespread-rain frame the ordering is separated by hundredths and is not
  stable frame to frame (MeteoCore #636). Do not read fine rank differences
  as meaningful.
- Use `significance_reasons` for the "why", and read `clutter` / `weakening`
  there as the reasons it ranked *lower*.

## 6. Absent vs null vs value

| State | Meaning | What you may say |
|---|---|---|
| Key **absent** | Source not configured on this collection | Nothing — omit the topic |
| Key **`null`** | Configured, not measured for this cell/frame | "Unknown", or omit. **Never** "no", "none", "0" |
| Key has a **value** | Measured | State it. `flash_count: 0` means genuinely quiet |

- `speed_ms: null` → new track, no velocity yet. **Not** "stationary".
- `deviant_mover: null` / `lightning_jump: null` → not computable yet. Not
  "false".
- `in_radar_coverage: null` → the radar could not say. Not "not covered".
- `beam_height_m: null` with `in_radar_coverage: true` → beyond the lowest
  sweep's reach, or the site advertised no sweep angles. No beam statement.
- `impact_over: null` → over sea or outside Finland. This *is* measured; you
  may say "not over any municipality".
- `first_flash` set with `flash_count: 0` → it flashed earlier, not now.
  Correct, not a contradiction.
- Lightning outside the network's coverage still reads `0`, not `null`
  (MeteoCore #621 is open). Cells far outside Finland's radar domain — over
  Russia, the Baltic states, the open Baltic — should not be described as
  lightning-free on that basis.

## 7. Generating text

1. **Only numbers present in the response.** No rainfall rate, hail size,
   wind speed or probability — none are in the data.
2. **Never present significance as a warning.** It is a hand-tuned ranking
   heuristic. Official warnings are the CAP collection `meteoalarm-finland`.
3. **No trend from one frame.** Use `volume_trend` / `intensity_trend_dbz_min`
   and the `intensifying` / `weakening` reasons; `null` means too new.
4. **No forecast positions.** `bearing_deg` and `impact_eta_minutes` are the
   only forward-looking values, and the ETA is to a municipal *boundary*
   under constant motion. Do not extrapolate further.
5. **Clutter before intensity.** Apply §4 before calling anything a storm.
6. **Beam height is above sea level**, not above ground, and says nothing
   below the beam. A 3 km beam height at 200 km range means the low levels
   are unobserved, not empty.
7. **Track ids restart on a server restart.** "Cell 47" is not durable across
   sessions.
8. **Precision.** `max_dbz` 0.1 dBZ, `area_km2` 0.1 km² (whole km² above
   100), speeds whole km/h, bearings whole degrees, ETA whole minutes,
   `significance` two decimals in prose. Do not print the server's four.

## 8. Finnish output

UI text is Finnish; existing vocabulary uses **ukkossolu** (see the MSG RDT
layer in `src/config.js`) and the strip's reason words live in `REASON_FI`
in `src/stormCells.js`.

| Value | Finnish |
|---|---|
| `weak` / `moderate` / `severe` / `very_severe` | heikko / kohtalainen / voimakas / erittäin voimakas |
| `growing` / `decaying` | voimistuva / heikkenevä |
| reason `intensifying` / `weakening` | voimistuu / heikkenee |
| reason `clutter`, `likely_clutter: true` | häiriökaiku · "ei sadetta — häiriökaiku" |
| `deviant_mover: true` | poikkeava liikesuunta |
| `lightning_jump: true` | salamointi voimistunut äkillisesti |
| `in_radar_coverage: false` | tutkan kantaman ulkopuolella |
| `nearest_radar_name`, `beam_height_m` | "Tutka: Kuopio 56 km, alin keila 0,7 km" |

**Never inflect place names in generation.** Finnish locative cases on proper
nouns are where small models fail, and a wrong case reads as broken Finnish.
Keep the name nominative:

- Good: `Ukkossolu alueella: Hyvinkää` · `Voimakas ukkossolu — Hyvinkää`
- Risky: `Ukkossolu lähestyy Hyvinkäätä`

Inflected forms must come from a lookup table, not the model.

## 9. Worked example

Live response fragment, 2026-09-08 06:10Z (rank 1 of 40, a minute after a
server restart):

```json
{
  "id": "18",
  "geometry": { "type": "Point", "coordinates": [26.98454, 62.39731] },
  "properties": {
    "significance": 0.634, "significance_rank": 1,
    "significance_reasons": ["severity", "impact", "max_dbz"],
    "severity": "very_severe", "max_dbz": 55.5, "area_km2": 16.4,
    "track_age": 2, "speed_ms": 1.1, "bearing_deg": 297,
    "net_displacement_km": 0.3, "path_straightness": null,
    "likely_clutter": false, "deviant_mover": false,
    "volume_trend": "growing", "intensity_trend_dbz_min": 0.176,
    "nearest_radar_id": "fikuo", "nearest_radar_name": "Kuopio",
    "nearest_radar_distance_km": 55.6, "in_radar_coverage": true,
    "beam_height_m": 741.0, "beam_elevation_deg": 0.3,
    "flash_count": 0, "flash_rate_per_min": 0.0, "ic_count": 0, "cg_count": 0,
    "cg_polarity_known": 0, "positive_cg_fraction": null, "first_flash": null,
    "lightning_jump": null, "jump_sigma": null,
    "impact_over": "Pieksämäki", "impact_approaching": null,
    "impact_eta_minutes": null, "observed": "2026-09-08T06:10:00Z"
  }
}
```

**Correct:**

> Voimakas, lähes paikallaan pysyvä kaiku alueella Pieksämäki — 55,5 dBZ,
> 16 km², nopeus 4 km/h, siirtymä 0,3 km. Tutka: Kuopio 56 km, alin keila
> 0,7 km. Ei salamointia. Tunnettu häiriökaikupaikka; todennäköisesti ei
> sadetta. Havaittu klo 06:10 UTC.

**Incorrect, and why:**

| Statement | Fault |
|---|---|
| "Erittäin voimakas ukkossolu Pieksämäellä" | A stationary 55 dBZ echo under a 741 m beam with 0.3 km of displacement is the wind-farm signature (§4 rule 2); also inflects the name |
| "Rankkasadetta 30 mm/h" | Rainfall rate is not in the data |
| "Varoitus: rajuilma" | Turns a ranking into a warning |
| "Salamointi ei ole voimistunut" | `lightning_jump: null` is unknown, not "no" |
| "Ei häiriökaikua, koska `likely_clutter` on false" | `false` at `track_age: 2` means untested, not cleared |
| "Merkittävin solu Suomessa" | Rank is per-frame ordering, and the frame is one minute old after a restart |

## 10. Known limits

- Retention and track ids reset on every server restart; the clutter flag
  cannot fire for the first 6 frames afterwards.
- `impact_eta_minutes` is time to a municipal boundary, not to the town
  (MeteoCore #622). `impact_over` is the centroid's municipality even when
  the cell's edge is somewhere else.
- Lightning fields read `0` outside the network's coverage (MeteoCore #621).
- Cells are points with an area; footprint polygons are not served
  (MeteoCore #551).
- `beam_height_m` is above mean sea level and models the lowest sweep only.
- Exposure weights municipal population on a log scale; the smallest
  municipalities carry almost no weight.
- Municipality polygons are land-only, so an offshore cell reports
  `impact_over: null` rather than the nearest coast.

## 11. Related

- WMS/EDR request-shape rules for this server: `CLAUDE.md`, section
  "MeteoCore request-shape rules".
- Official warnings: `meteoalarm-finland` collection (CAP).
- Server-side design: `crates/engine-nowcast/CLAUDE.md` in the MeteoCore
  repo; open work: MeteoCore issues #620, #621, #622, #646, #649, #650.
