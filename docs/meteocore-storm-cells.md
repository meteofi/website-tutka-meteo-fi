# MeteoCore storm cells — reference for LLM consumers

Reference for a model reading MeteoCore's tracked storm-cell layer, either to
build UI in this repo or to describe the weather situation in text.

Everything below is a contract, not a suggestion. The failure mode this
document exists to prevent is a model producing a **fluent, confident sentence
that the data does not support** — a `null` read as zero, a ranking read as a
warning, a single frame read as a trend.

---

## 1. What the layer is

Every 5 minutes MeteoCore segments the FMI radar composite at 35 dBZ into
tracked cells, carries their identity across frames, and for each one computes:

- radar attributes (peak reflectivity, area, motion),
- lifecycle (age, growing/decaying, intensity trend),
- lightning attribution (flash count/rate, jump flag),
- impact context (which municipality it is over or heading toward),
- a composite **significance** score and rank.

Cells describe **observed** frames only. The same collection also serves
motion-extrapolated *raster* imagery up to 2 h ahead, but there are no cells for
future times.

## 2. Endpoint

```
GET https://meteocore.app.meteo.fi/features/collections/fmi-radar-nowcast/items
```

GeoJSON `FeatureCollection`, `Point` geometry, CRS84 (`[lon, lat]`).
Feature `id` = track id as a string.

| Parameter | Values | Notes |
|---|---|---|
| `limit` | 1–1000, default 100 | Use `limit=1000` to get a whole frame |
| `bbox` | `west,south,east,north` | WGS84, filters on centroid |
| `datetime` | RFC 3339 instant or interval | Newest retained frame inside the interval |
| `offset` | ≥ 0 | Paging |

Standard request for "the current situation":

```
/items?limit=1000
```

For one animation frame:

```
/items?datetime=2026-08-21T14:25:00Z&limit=1000
```

Responses carry an `ETag` and `Cache-Control: public, max-age=60`. Send
`If-None-Match` and expect `304`. Data changes only every 5 minutes, so polling
faster than 60 s yields nothing.

### There is no server-side sorting

`sortby` is **not implemented**. Passing it returns HTTP 200 with results in
arbitrary track order — it fails silently and looks like it worked.

Therefore `limit=10` returns ten arbitrary cells, **not** the ten most
significant. To rank: fetch the whole frame with `limit=1000` and sort locally
on `significance_rank`. Tracking issue: MeteoCore #605.

## 3. Fields

All fields are inside `properties`.

| Field | Type | Unit | Meaning |
|---|---|---|---|
| `significance` | float | 0–1 | Composite "is this worth attention" score |
| `significance_rank` | int | — | 1-based position **within this frame** |
| `significance_reasons` | string[] | — | Up to 3 top contributing terms, strongest first |
| `severity` | string | — | `weak` \| `moderate` \| `severe` \| `very_severe` |
| `max_dbz` | float | dBZ | Peak reflectivity |
| `area_km2` | float | km² | Footprint above 35 dBZ |
| `observed` | string | RFC 3339 | Analysis instant of this frame |
| `track_age` | int | frames | 1 = first seen this frame |
| `speed_ms` | float \| null | m/s | Ground speed |
| `bearing_deg` | float \| null | ° | Compass bearing moved **toward** |
| `volume_trend` | string \| null | — | `growing` \| `decaying` |
| `intensity_trend_dbz_min` | float \| null | dBZ/min | Signed measured trend |
| `deviant_mover` | bool | — | Sustained motion off the ambient flow |
| `flash_count` | int \| null | strikes | Since previous frame |
| `flash_rate_per_min` | float \| null | 1/min | Same window |
| `lightning_jump` | bool \| null | — | Schultz-style 2σ flash-rate jump |
| `impact_over` | string \| null | — | Municipality beneath the cell |
| `impact_approaching` | string \| null | — | Next municipality within 60 min |
| `impact_eta_minutes` | float \| null | min | Time to `impact_approaching` |

## 4. severity and significance are different questions

Do not use them interchangeably. They disagree often, and the disagreement
carries the information.

### severity — coarse label, radar only

One point each for `max_dbz ≥ 45`, `≥ 50`, `≥ 55`, and `area_km2 ≥ 50`:

| Points | `severity` |
|---|---|
| 0 | `weak` |
| 1 | `moderate` |
| 2 | `severe` |
| 3–4 | `very_severe` |

Intensity and size are interchangeable, so a 46 dBZ / 300 km² cell and a
56 dBZ / 20 km² cell are both `severe`. On an active day most of the top of the
list is `very_severe`, at which point the label stops discriminating.

### significance — weighted score, includes impact

Weighted mean of normalized terms; `impact` carries the largest weight, which is
why a moderate cell over a town outranks a very severe cell over open sea.

Two hard rules:

- **Compare ranks, not scores, across frames or configurations.** Terms with no
  data drop out of the calculation entirely, so absolute scores shift when a
  source is added or a cell lacks coverage. Ordering within one frame is sound.
- **`significance_rank` is scoped to its frame.** Rank 1 means "highest in this
  frame", not a persistent property of that storm.

`significance_reasons` names the terms that drove the score. Use it for the
"why" — it is the difference between a number a forecaster trusts and one they
dismiss.

## 5. Absent vs null vs value

Three states, three meanings. Collapsing them into two produces false
statements.

| State | Meaning | What you may say |
|---|---|---|
| Key **absent** | Source not configured on this collection | Nothing. Omit the topic entirely |
| Key present, **`null`** | Configured but not measured this frame | "Unknown" / omit. **Never** "no", "none" or "0" |
| Key present, **value** | Measured | State it. `flash_count: 0` means genuinely quiet |

Concretely:

- `lightning_jump: null` does **not** mean no jump. It means unknown.
- `impact_over: null` means the cell is over sea or outside Finland — that is a
  measured fact, and you may say "not over any municipality".
- `speed_ms: null` means the track is new (`track_age: 1`) and has no velocity
  yet. Do not say it is stationary.

## 6. Rules for generating text about cells

1. **Only state numbers present in the response.** Every figure you write must
   be traceable to a field. Do not compute derived quantities such as rainfall
   rate, hail size, wind speed or probability — none are in the data.
2. **Never present significance as a warning.** It is a ranking heuristic tuned
   by hand, not an issued alert and not a probability. Official warnings come
   from the CAP collection (`meteoalarm-finland`), which carries real severity,
   certainty and urgency. Never merge the two vocabularies.
3. **Do not infer a trend from one frame.** Use `volume_trend` and
   `intensity_trend_dbz_min`. If they are `null`, the cell is too new to have a
   trend — say nothing about intensification.
4. **Do not forecast cell positions.** Cells are analysis-only. `bearing_deg` and
   `impact_eta_minutes` are the only forward-looking values, and the ETA already
   assumes constant motion. Do not extrapolate further yourself.
5. **Respect the horizon.** The extrapolated raster imagery runs 2 h ahead with
   no growth or decay applied; convective skill decays after roughly an hour.
   Do not describe a 2 h lead with the same confidence as the analysis.
6. **Track ids are not stable across a server restart.** They restart from 1 on
   reload. Do not treat "cell 47" as a durable identifier across sessions.
7. **Rounding.** `max_dbz` to 0.1 dBZ, `area_km2` to 0.1, `speed_ms` to 0.1,
   `bearing_deg` to whole degrees, ETA to whole minutes. Do not present more
   precision than that.

## 7. Finnish output

UI text in this repo is Finnish. Existing vocabulary here uses **ukkossolu** for
a thunderstorm cell (see the MSG RDT layer in `src/config.js`).

| Field value | Finnish |
|---|---|
| `weak` | heikko |
| `moderate` | kohtalainen |
| `severe` | voimakas |
| `very_severe` | erittäin voimakas |
| `growing` | voimistuva |
| `decaying` | heikkenevä |
| `deviant_mover: true` | poikkeava liikesuunta |
| `lightning_jump: true` | salamointi voimistunut äkillisesti |

**Place names must not be inflected by generation.** Finnish locative cases on
proper nouns are where small models fail — *Tampereen / Tampereelle /
Tampereella* are easy to get wrong, and a wrong case reads as broken Finnish.
Use a construction that keeps the name in the nominative:

- Good: `Ukkossolu alueella: Hyvinkää` · `Voimakas ukkossolu — Hyvinkää`
- Risky: `Ukkossolu lähestyy Hyvinkäätä` (inflection generated, may be wrong)

If inflected forms are needed, they must come from a lookup table, not from the
model.

## 8. Worked example

Response fragment:

```json
{
  "id": "82",
  "geometry": { "type": "Point", "coordinates": [24.277, 61.080] },
  "properties": {
    "significance": 0.4636, "significance_rank": 4,
    "significance_reasons": ["severity", "max_dbz", "trend"],
    "severity": "very_severe", "max_dbz": 61.5, "area_km2": 43.3,
    "track_age": 3, "speed_ms": 6.6, "bearing_deg": 69,
    "volume_trend": "growing", "intensity_trend_dbz_min": 0.42,
    "deviant_mover": false,
    "flash_count": 9, "flash_rate_per_min": 1.8, "lightning_jump": false,
    "impact_over": "Hämeenlinna", "impact_approaching": null,
    "impact_eta_minutes": null, "observed": "2026-08-21T14:05:00Z"
  }
}
```

**Correct:**

> Erittäin voimakas ukkossolu, alueella Hämeenlinna. Huippuheijastavuus
> 61,5 dBZ, pinta-ala 43 km², voimistuva. Salamointia 9 iskua viime
> viiteen minuuttiin. Havaittu klo 14:05 UTC.

**Incorrect, and why:**

| Statement | Fault |
|---|---|
| "Rankkasadetta 30 mm/h" | Rainfall rate is not in the data |
| "Varoitus: rajuilma Hämeenlinnassa" | Turns a ranking into a warning; also inflects the place name |
| "Ei salamointia" | `lightning_jump: false` is not "no lightning"; `flash_count` is 9 |
| "Solu saapuu Tampereelle 20 min kuluttua" | `impact_approaching` is `null` — no arrival is predicted |
| "Neljänneksi vaarallisin solu Suomessa" | Rank is per-frame ordering, not a danger league table |

## 9. Known limits

- Sorting is client-side only (MeteoCore #605).
- `impact_approaching` / `impact_eta_minutes` need a velocity, so they are absent
  for `track_age: 1`. After a server reload every track is new and ETAs are
  missing for a few frames.
- Municipality polygons are **land-only**, so a cell offshore correctly reports
  `impact_over: null` rather than claiming the nearest coastal municipality.
- Roughly 4 h of frames are retained for `datetime` queries; the buffer empties
  on reload.
- Exposure is weighted by municipal population on a log scale. Municipalities
  near 100 inhabitants carry almost no weight, so a cell over the very smallest
  ones ranks close to one over open sea.

## 10. Related

- WMS/EDR request-shape rules for this server: `CLAUDE.md`, section "MeteoCore
  request-shape rules".
- Official warnings: `meteoalarm-finland` collection (CAP).
- Server-side design: `crates/engine-nowcast/CLAUDE.md` in the MeteoCore repo.
