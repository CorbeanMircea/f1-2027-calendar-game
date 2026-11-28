// Lights Out: the database and the browser must score every prediction the same way (T8).
// The scoring rules exist twice: the database function calc_points (it writes the real scores) and scorecard-engine.js (it explains
// a score on the Score check page). This test feeds the SAME randomly generated predictions and results to both and compares the
// total AND every component. The random numbers come from a fixed seed, so a failure can always be reproduced.
// No browser, no API: the database is reached through the local test container only.
const { test, expect } = require("@playwright/test");
const db = require("../fixtures/local-db");
const { loadScorecardEngine } = require("../fixtures/load-engine");

const engine = loadScorecardEngine();
const DRIVERS = ["alb", "alo", "ant", "bea", "bor", "bot", "col", "gas", "had", "ham", "hul", "law", "lec", "lin", "nor", "oco", "per", "pia", "rus", "sai", "str", "ver"]
  .map(function (code) { return "2026-" + code; });

// A small, fixed-seed random number generator (mulberry32).
function makeRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed) {
  const random = makeRandom(seed);
  const int = function (n) { return Math.floor(random() * n); };
  const shuffle = function (list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = int(i + 1); const tmp = out[i]; out[i] = out[j]; out[j] = tmp; }
    return out;
  };
  const chance = function (p) { return random() < p; };
  // A prediction near a result: copy it, then swap some places and replace some drivers.
  const near = function (actual, pool) {
    const out = actual.slice();
    const swaps = int(4);
    for (let i = 0; i < swaps; i++) { const a = int(out.length); const b = int(out.length); const t = out[a]; out[a] = out[b]; out[b] = t; }
    const replaced = int(3);
    for (let i = 0; i < replaced; i++) {
      const spare = pool.filter(function (d) { return out.indexOf(d) === -1; });
      out[int(out.length)] = spare[int(spare.length)];
    }
    return out;
  };

  function qualifying(type) {
    const a = shuffle(DRIVERS);
    const actual = { q1_out: a.slice(0, 6), q2_out: a.slice(6, 12), q3_order: a.slice(12, 22) };
    let picks;
    if (chance(0.5)) {
      const b = shuffle(DRIVERS);
      picks = { q1_out: b.slice(0, 6), q2_out: b.slice(6, 12), q3_order: b.slice(12, 22) };
    } else {
      const order = near(actual.q1_out.concat(actual.q2_out, actual.q3_order), DRIVERS);
      picks = { q1_out: order.slice(0, 6), q2_out: order.slice(6, 12), q3_order: order.slice(12, 22) };
    }
    return { type: type, picks: picks, actual: actual };
  }

  function sprint() {
    const actual = { top8: shuffle(DRIVERS).slice(0, 8) };
    const picks = { top8: chance(0.4) ? shuffle(DRIVERS).slice(0, 8) : near(actual.top8, DRIVERS) };
    return { type: "sprint", picks: picks, actual: actual };
  }

  function race() {
    const top8 = shuffle(DRIVERS).slice(0, 8);
    const rest = DRIVERS.filter(function (d) { return top8.indexOf(d) === -1; });
    const dnfActual = shuffle(rest).slice(0, int(6));
    const grid = chance(0.5)
      ? shuffle(dnfActual.concat(top8)).slice(0, 8)
      : shuffle(DRIVERS).slice(0, 8);
    const actual = { top8: top8, fastest_lap: chance(0.5) ? top8[int(8)] : DRIVERS[int(22)], dnf_drivers: dnfActual, grid_top8: grid };

    const pickTop = chance(0.4) ? shuffle(DRIVERS).slice(0, 8) : near(top8, DRIVERS);
    const room = DRIVERS.filter(function (d) { return pickTop.indexOf(d) === -1; });
    const anyDnf = chance(0.6);
    const count = chance(0.5) ? Math.max(0, dnfActual.length + int(3) - 1) : int(6);
    let dnfPicks = [];
    if (anyDnf) {
      const wanted = Math.min(count, room.length, 5);
      const fromActual = shuffle(dnfActual.filter(function (d) { return room.indexOf(d) !== -1; })).slice(0, int(wanted + 1));
      dnfPicks = fromActual.slice();
      shuffle(room).forEach(function (d) { if (dnfPicks.length < wanted && dnfPicks.indexOf(d) === -1) { dnfPicks.push(d); } });
    }
    const picks = { top8: pickTop, fastest_lap: chance(0.4) ? actual.fastest_lap : DRIVERS[int(22)], any_dnf: anyDnf, dnf_count: count, dnf_drivers: dnfPicks };
    if (anyDnf && dnfPicks.length === 1 && chance(0.3)) { picks.dnf_drivers = []; picks.dnf_driver = dnfPicks[0]; } // the old single-driver field
    return { type: "race", picks: picks, actual: actual };
  }

  return { qualifying: qualifying, sprint: sprint, race: race };
}

function buildCases() {
  const g = generator(20261126);
  const cases = [];
  for (let i = 0; i < 150; i++) { cases.push(g.qualifying("qualifying")); }
  for (let i = 0; i < 50; i++) { cases.push(g.qualifying("sprint_qualifying")); }
  for (let i = 0; i < 120; i++) { cases.push(g.sprint()); }
  for (let i = 0; i < 400; i++) { cases.push(g.race()); }
  return cases;
}

function databaseScores(cases) {
  const json = JSON.stringify(cases);
  const sql = "select coalesce(json_agg(public.calc_points(t.c ->> 'type', t.c -> 'picks', t.c -> 'actual') order by t.ord), '[]')\n" +
              "from jsonb_array_elements($lo$" + json + "$lo$::jsonb) with ordinality as t(c, ord);";
  return JSON.parse(db.psqlStdin(sql));
}

test.describe("scoring: database function versus browser engine", function () {
  const cases = buildCases();
  let results;

  test.beforeAll(function () {
    results = databaseScores(cases);
  });

  test("the generated cases cover every session type and a wide range of scores", function () {
    expect(results.length).toBe(cases.length);
    const totals = results.map(function (r) { return r.total; });
    expect(Math.max.apply(null, totals), "some predictions should score highly").toBeGreaterThan(30);
    expect(totals.filter(function (t) { return t === 0; }).length, "some predictions should score nothing").toBeGreaterThan(0);
    const raceCases = cases.filter(function (c) { return c.type === "race"; });
    expect(raceCases.filter(function (c) { return c.actual.dnf_drivers.length > 0; }).length, "retirements must be common").toBeGreaterThan(100);
    expect(raceCases.filter(function (c) { return c.picks.dnf_driver; }).length, "the legacy dnf_driver field must be exercised").toBeGreaterThan(0);
  });

  test("every total is identical (" + cases.length + " random predictions)", function () {
    const different = [];
    cases.forEach(function (c, i) {
      const browser = engine.explain(c.type, c.picks, c.actual).total;
      if (browser !== results[i].total) { different.push({ case: c, database: results[i].total, browser: browser }); }
    });
    expect(different.slice(0, 3), different.length + " of " + cases.length + " totals differ").toEqual([]);
  });

  test("every component of every score is identical, not only the total", function () {
    const different = [];
    cases.forEach(function (c, i) {
      const browser = engine.explain(c.type, c.picks, c.actual).components;
      const database = Object.assign({}, results[i]);
      delete database.total;
      if (JSON.stringify(sortKeys(browser)) !== JSON.stringify(sortKeys(database))) {
        different.push({ type: c.type, database: database, browser: browser });
      }
    });
    expect(different.slice(0, 3), different.length + " of " + cases.length + " breakdowns differ").toEqual([]);
  });

  test("no score is above the published maximum, and the components add up to the total", function () {
    results.forEach(function (r, i) {
      const c = cases[i];
      const sum = Object.keys(r).filter(function (k) { return k !== "total"; }).reduce(function (t, k) { return t + r[k]; }, 0);
      expect(sum, JSON.stringify(c)).toBe(r.total);
      const maximum = c.type === "race" ? 65 + 8 * 5 : c.type === "sprint" ? 32 : 62;
      expect(r.total, c.type).toBeLessThanOrEqual(maximum);
    });
  });
});

function sortKeys(object) {
  const out = {};
  Object.keys(object).sort().forEach(function (k) { out[k] = object[k]; });
  return out;
}
