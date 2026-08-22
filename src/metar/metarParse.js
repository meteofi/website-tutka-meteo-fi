// Decoding a raw METAR into the values a station plot draws.
//
// Pure and dependency-free (the gliderTrail.js / trainQuery.js shape) so it can
// be run against the live wire from a node harness. That matters more here than
// usual: METAR is a terse positional format where a misread group does not throw,
// it silently yields a plausible wrong number — an RVR group mistaken for the
// temperature pair would put a believable temperature on the map.
//
// WHAT THE WIRE ACTUALLY CARRIES, measured over 1119 reports from 24 Finnish
// aerodromes on 2026-08-14. The distribution decided what this parser optimises
// for and what it merely tolerates:
//
//   CAVOK                    887   the dominant case by far
//   Q (hPa) pressure        1119   every single report
//   A (inHg) pressure          0   parsed anyway; it is simply not the European form
//   variable range dddVddd   365
//   VRB wind                 200
//   cloud FEW/SCT/BKN/OVC    185
//   visibility 4-digit       232   (9999 in 197 of them)
//   NSC/NCD/SKC/CLR           26
//   RVR  R21/P2000D           34   must be skipped without being read as temperature
//   present weather           46   -DZ, BCFG, FG, -SHRA
//   VV001 vertical visibility  21
//   calm 00000KT              19
//   gusts                      1   rare, but real
//   CB/TCU                     0   in this sample; still handled
//
// The hardest report in the sample, and a good test of group discipline:
//   EFRO 140550Z 13008KT 9999 0800 R21/P2000D OVC001 09/09 Q1017=
// two visibilities, an RVR group, and a temperature pair that a looser regex
// would happily find inside the RVR.

// Cloud amount in oktas. The station-model circle is filled by this.
const COVER_OKTAS = {
  SKC: 0, NCD: 0, CLR: 0, NSC: 0, FEW: 1, SCT: 3, BKN: 6, OVC: 8,
};

// A ceiling is the lowest BKN or OVC layer — few and scattered are not a ceiling.
const CEILING_COVERS = new Set(['BKN', 'OVC']);

// Flight category, from ceiling and visibility. This is the one judgement a pilot
// makes before reading anything else, so the plot colours the station circle by it.
// Thresholds are the standard ones: LIFR <500 ft or <1 sm, IFR <1000 ft or <3 sm,
// MVFR <3000 ft or <5 sm, else VFR. Visibility is metric on the wire; the
// statute-mile boundaries are 1609/4828/8047 m.
export function flightCategory(ceilingFt, visM) {
  const ceil = Number.isFinite(ceilingFt) ? ceilingFt : Infinity;
  const vis = Number.isFinite(visM) ? visM : Infinity;
  if (ceil < 500 || vis < 1609) return 'LIFR';
  if (ceil < 1000 || vis < 4828) return 'IFR';
  if (ceil < 3000 || vis < 8047) return 'MVFR';
  return 'VFR';
}

// The report's own timestamp is a day-of-month and a time — no month, no year.
// Resolved against a reference instant (the fetch time), stepping back a month
// when the day is ahead of it, which happens for the last reports of a month
// read in the first hours of the next.
export function reportTimeMs(dayOfMonth, hour, minute, referenceMs = Date.now()) {
  const ref = new Date(referenceMs);
  const guess = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), dayOfMonth, hour, minute);
  // More than a day in the future means the report belongs to the previous month.
  if (guess - referenceMs > 24 * 3600 * 1000) {
    return Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, dayOfMonth, hour, minute);
  }
  return guess;
}

// Wind: dddffKT, dddffGggKT, VRBffKT, 00000KT, optionally followed by a
// dddVddd variability range. Speeds can be in KT, MPS or KMH — Finland reports
// knots, but the unit is part of the group and reading it wrong would be a
// silent factor-of-two error.
function parseWind(token) {
  const m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(token);
  if (!m) return null;
  const toKt = { KT: 1, MPS: 1.94384, KMH: 0.539957 }[m[4]];
  const speed = Number(m[2]) * toKt;
  const gust = m[3] === undefined ? null : Number(m[3]) * toKt;
  return {
    // VRB means the direction is genuinely variable, not unknown: the barb
    // cannot be drawn, and saying so is the honest plot.
    variable: m[1] === 'VRB',
    direction: m[1] === 'VRB' ? null : Number(m[1]),
    speedKt: speed,
    gustKt: gust,
    // Calm is its own case in the symbology — a bare circle, not a zero-length barb.
    calm: Number(m[2]) === 0 && m[1] !== 'VRB',
  };
}

// Cloud layer: FEWnnn / SCTnnn / BKNnnn / OVCnnn with an optional CB or TCU
// suffix, plus the no-cloud forms and VVnnn for a sky obscured by fog. Heights
// are in hundreds of feet above the aerodrome.
function parseCloud(token) {
  const vv = /^VV(\d{3}|\/\/\/)$/.exec(token);
  if (vv) {
    // Sky obscured: not a cloud layer but a vertical visibility. It is a ceiling
    // for every purpose the plot cares about, and 8 oktas is how it is drawn.
    const base = vv[1] === '///' ? null : Number(vv[1]) * 100;
    return {
      cover: 'VV', oktas: 8, baseFt: base, ceiling: true, convective: null,
    };
  }
  if (/^(SKC|CLR|NCD|NSC)$/.test(token)) {
    return {
      cover: token, oktas: 0, baseFt: null, ceiling: false, convective: null,
    };
  }
  // An automatic station that sees a convective cloud it cannot measure reports
  // the amount and the base as slashes: `//////CB`. Dropping it lost the one
  // token in the report that matters most to this app — EFTU was carrying
  // `FEW043 //////CB` while the panel said nothing about a CB at all. Kept with
  // an unknown cover, and at 0 oktas so it cannot inflate the station circle,
  // which draws total sky cover.
  const auto = /^\/{3}(\d{3}|\/{3})(CB|TCU)?$/.exec(token);
  if (auto) {
    return {
      cover: '///',
      oktas: 0,
      baseFt: auto[1] === '///' ? null : Number(auto[1]) * 100,
      ceiling: false,
      convective: auto[2] || null,
    };
  }
  const m = /^(FEW|SCT|BKN|OVC)(\d{3}|\/\/\/)(CB|TCU)?$/.exec(token);
  if (!m) return null;
  return {
    cover: m[1],
    oktas: COVER_OKTAS[m[1]],
    baseFt: m[2] === '///' ? null : Number(m[2]) * 100,
    ceiling: CEILING_COVERS.has(m[1]),
    convective: m[3] || null,
  };
}

// Present weather: an optional intensity or VC (in the vicinity), an optional
// descriptor, and one or more phenomena. Kept as the raw token — the WMO symbol
// set is ~100 glyphs and a project of its own, so the plot shows the text.
const WEATHER_RE = /^(\+|-|VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$/;

// One raw report, e.g.
//   EFHK 140550Z 11005KT CAVOK 15/11 Q1021 NOSIG=
// Returns null when the line is not a report at all. Never throws: a station
// whose report cannot be read should vanish from the plot, not take the layer
// down with it.
export function parseMetar(raw, referenceMs = Date.now()) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/=+$/, '').trim();
  if (!text) return null;
  const tokens = text.split(/\s+/);
  const icao = tokens.shift();
  if (!/^[A-Z]{4}$/.test(icao || '')) return null;

  // METAR / SPECI may precede the station; the fetched feed puts the station first.
  const stamp = tokens.shift();
  const ts = /^(\d{2})(\d{2})(\d{2})Z$/.exec(stamp || '');
  if (!ts) return null;
  const timeMs = reportTimeMs(Number(ts[1]), Number(ts[2]), Number(ts[3]), referenceMs);

  const out = {
    icao,
    timeMs,
    raw: text,
    auto: false,
    wind: null,
    windVariableFrom: null,
    windVariableTo: null,
    cavok: false,
    visM: null,
    clouds: [],
    weather: [],
    tempC: null,
    dewpC: null,
    qnhHpa: null,
  };

  // Everything after a trend or remark group describes the FUTURE or is
  // commentary, and must not be read as observed values — a TEMPO group carries
  // its own wind and visibility, which would otherwise overwrite the real ones.
  const stopAt = tokens.findIndex((t) => /^(NOSIG|BECMG|TEMPO|RMK)$/.test(t));
  const body = stopAt === -1 ? tokens : tokens.slice(0, stopAt);

  // A forEach rather than a for/continue: the airbnb rules forbid `continue`,
  // and a token handler that returns early reads the same way.
  let seenTempGroup = false;
  body.forEach((token) => {
    if (token === 'AUTO' || token === 'COR') {
      out.auto = out.auto || token === 'AUTO';
      return;
    }
    if (token === 'CAVOK') {
      // Ceiling and visibility OK: visibility 10 km or more, no cloud below
      // 5000 ft, no significant weather. It is a statement about all three,
      // which is why it is a branch rather than a token.
      out.cavok = true;
      out.visM = 10000;
      return;
    }
    // RVR: runway visual range, e.g. R21/P2000D or R08/0350N. Skipped early —
    // its digits are the group most able to impersonate something else.
    if (/^R\d{2}[LCR]?\//.test(token)) return;

    const wind = out.wind ? null : parseWind(token);
    if (wind) {
      out.wind = wind;
      return;
    }

    const varRange = /^(\d{3})V(\d{3})$/.exec(token);
    if (varRange && out.wind) {
      out.windVariableFrom = Number(varRange[1]);
      out.windVariableTo = Number(varRange[2]);
      return;
    }

    // Temperature and dew point, M for minus. Checked BEFORE plain visibility so
    // a 4-digit visibility cannot be confused with it, and after RVR for the
    // same reason in the other direction.
    const temp = /^(M?\d{2})\/(M?\d{2})$/.exec(token);
    if (temp) {
      const num = (v) => (v.startsWith('M') ? -Number(v.slice(1)) : Number(v));
      out.tempC = num(temp[1]);
      out.dewpC = num(temp[2]);
      seenTempGroup = true;
      return;
    }

    const qnh = /^Q(\d{4})$/.exec(token);
    if (qnh) {
      out.qnhHpa = Number(qnh[1]);
      return;
    }
    // Inches of mercury, hundredths. Not the European form — zero occurrences in
    // the Finnish sample — but converting is cheaper than being wrong abroad.
    const altim = /^A(\d{4})$/.exec(token);
    if (altim) {
      out.qnhHpa = Math.round((Number(altim[1]) / 100) * 33.8639);
      return;
    }

    const cloud = parseCloud(token);
    if (cloud) {
      out.clouds.push(cloud);
      return;
    }

    // Visibility in metres, 9999 meaning 10 km or more. Only before the
    // temperature group: the same four digits after it would be a trend value.
    // A second such group is the minimum visibility in another direction, which
    // is the lower and more conservative number to plot.
    if (!seenTempGroup && /^\d{4}$/.test(token)) {
      const metres = Number(token) === 9999 ? 10000 : Number(token);
      out.visM = out.visM === null ? metres : Math.min(out.visM, metres);
      return;
    }
    // Statute miles, e.g. 6SM or 1/2SM. American form; handled for completeness.
    const sm = /^(\d+)(?:\/(\d+))?SM$/.exec(token);
    if (sm) {
      const miles = sm[2] ? Number(sm[1]) / Number(sm[2]) : Number(sm[1]);
      out.visM = Math.round(miles * 1609.34);
      return;
    }
    if (WEATHER_RE.test(token)) out.weather.push(token);
  });

  const ceilingLayer = out.clouds.find((c) => c.ceiling && Number.isFinite(c.baseFt));
  out.ceilingFt = ceilingLayer ? ceilingLayer.baseFt : null;
  // CAVOK asserts no cloud below 5000 ft, so its ceiling is unlimited rather
  // than unknown — the distinction decides the flight category.
  const ceilingForCat = out.cavok ? Infinity : out.ceilingFt;
  out.fltCat = flightCategory(ceilingForCat, out.visM);
  // The largest okta value present: the station circle shows total sky cover,
  // and layers are reported cumulatively upward.
  // Total sky cover: the largest okta value present, since layers are
  // reported cumulatively upward. CAVOK asserts nothing below 5000 ft, so 0.
  out.oktas = out.clouds.reduce((max, c) => Math.max(max, c.oktas), 0);
  return out;
}

// A feed is many reports for one station, oldest first. Parsed newest-last so a
// later correction of the same minute wins.
export function parseMetarFeed(text, referenceMs = Date.now()) {
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => parseMetar(line, referenceMs))
    .filter(Boolean)
    .sort((a, b) => a.timeMs - b.timeMs);
}

// The report that was current at `atMs`: the newest at or before it. Reports
// arrive every 30 minutes while the animation steps every 5, so six frames share
// one report — which is why the plot always states the report's own time rather
// than implying it is fresh.
//
// A cursor ahead of the newest report (the nowcast frames) clamps to the newest:
// the alternative is a plot that blanks at the live edge, which reads as an
// outage rather than as "no newer report exists yet".
export function reportAt(reports, atMs) {
  if (!Array.isArray(reports) || !reports.length) return null;
  let found = null;
  for (const report of reports) {
    if (report.timeMs <= atMs) found = report;
    else break;
  }
  // A cursor before the oldest report held: show nothing rather than a report
  // from after the moment being displayed.
  return found;
}
