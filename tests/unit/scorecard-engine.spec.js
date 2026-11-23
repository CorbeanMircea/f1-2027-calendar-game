// Lights Out: unit tests of scorecard-engine.js (T2).
// The engine is the browser copy of the database function calc_points. These tests pin the scoring rules with
// scenarios calculated BY HAND from the published rules (how-to-play.html), so a wrong rule in the engine is caught.
// Driver ids are fake (d01, d02 ...) so the tests do not depend on any real season data.
// No browser, no network, no database.
const { test, expect } = require("@playwright/test");
const { loadScorecardEngine } = require("../fixtures/load-engine");

const engine = loadScorecardEngine();

function ids(from, to) {
  const out = [];
  for (let n = from; n <= to; n++) { out.push("d" + String(n).padStart(2, "0")); }
  return out;
}
function total(type, picks, actual) { return engine.explain(type, picks, actual).total; }

// ---------------------------------------------------------------- Qualifying (maximum 62)
// 22 drivers: 6 knocked out in Q1 (d17-d22), 6 in Q2 (d11-d16), 10 reach Q3 (d01-d10, in this order).
const Q_ACTUAL = { q1_out: ids(17, 22), q2_out: ids(11, 16), q3_order: ids(1, 10) };

test.describe("qualifying scoring", function () {
  test("a perfect prediction scores the published maximum of 62", function () {
    // 6 + 6 group points, 10 reached Q3 (10) + 10 exact positions (30) + perfect-order bonus (10)
    const r = engine.explain("qualifying", Q_ACTUAL, Q_ACTUAL);
    expect(r.total).toBe(62);
    expect(r.components).toEqual({ group: 22, exact: 30, bonus: 10 });
  });

  test("an empty or completely wrong prediction scores 0", function () {
    expect(total("qualifying", {}, Q_ACTUAL)).toBe(0);
    const wrong = { q1_out: ids(1, 6), q2_out: ids(1, 6), q3_order: ids(11, 20) };
    expect(total("qualifying", wrong, Q_ACTUAL)).toBe(0);
  });

  test("right drivers in the wrong order earn 1 point each and no bonus", function () {
    const reversed = { q1_out: [], q2_out: [], q3_order: ids(1, 10).reverse() };
    const r = engine.explain("qualifying", reversed, Q_ACTUAL);
    expect(r.total).toBe(10);
    expect(r.components).toEqual({ group: 10, exact: 0, bonus: 0 });
  });

  test("a mixed prediction adds up exactly", function () {
    // Q1: 3 of 6 right = 3.   Q2: 2 right = 2.
    // Q3: picks 1-4 exact = 4 x 4 = 16; picks 5, 7, 8, 9 and 10 reached Q3 but in another place = 5 x 1 = 5;
    //     pick 6 went out in Q2 = 0.   Total 3 + 2 + 16 + 5 = 26.
    const picks = {
      q1_out: ["d17", "d18", "d19", "d01", "d02", "d03"],
      q2_out: ["d11", "d12", "d01", "d02", "d03", "d04"],
      q3_order: ["d01", "d02", "d03", "d04", "d08", "d11", "d05", "d06", "d07", "d09"]
    };
    const r = engine.explain("qualifying", picks, Q_ACTUAL);
    expect(r.components).toEqual({ group: 14, exact: 12, bonus: 0 });
    expect(r.total).toBe(26);
  });

  test("sprint qualifying uses the same rules as qualifying", function () {
    expect(total("sprint_qualifying", Q_ACTUAL, Q_ACTUAL)).toBe(62);
  });
});

// ---------------------------------------------------------------- Sprint (maximum 32)
const S_ACTUAL = { top8: ids(1, 8) };

test.describe("sprint scoring", function () {
  test("a perfect top 8 scores 8 x 3 + 8 bonus = 32", function () {
    const r = engine.explain("sprint", { top8: ids(1, 8) }, S_ACTUAL);
    expect(r.total).toBe(32);
    expect(r.components).toEqual({ exact: 24, in_top8: 0, bonus: 8 });
  });

  test("exact = 3, right driver in the wrong place = 1, outside the top 8 = 0", function () {
    // d01 d02 d03 exact (9); d05 and d04 swapped = 2 near (2); d20 d21 d22 not in the top 8 (0)
    const picks = { top8: ["d01", "d02", "d03", "d05", "d04", "d20", "d21", "d22"] };
    const r = engine.explain("sprint", picks, S_ACTUAL);
    expect(r.components).toEqual({ exact: 9, in_top8: 2, bonus: 0 });
    expect(r.total).toBe(11);
  });

  test("seven exact picks do not earn the bonus", function () {
    const picks = { top8: ["d01", "d02", "d03", "d04", "d05", "d06", "d07", "d20"] };
    expect(total("sprint", picks, S_ACTUAL)).toBe(21);
  });

  test("no prediction scores 0", function () {
    expect(total("sprint", {}, S_ACTUAL)).toBe(0);
  });
});

// ---------------------------------------------------------------- Race (maximum 65 + 8 per DNF driver)
const R_NO_DNF = { top8: ids(1, 8), fastest_lap: "d01", dnf_drivers: [], grid_top8: ids(1, 8) };

test.describe("race scoring", function () {
  test("a perfect prediction with no retirements scores 65", function () {
    // 8 x 5 = 40, perfect bonus 15, fastest lap 3, any DNF right 2, DNF count right 5
    const picks = { top8: ids(1, 8), fastest_lap: "d01", any_dnf: false, dnf_count: 0, dnf_drivers: [] };
    const r = engine.explain("race", picks, R_NO_DNF);
    expect(r.total).toBe(65);
    expect(r.components).toEqual({ exact: 40, in_top8: 0, bonus: 15, fastest_lap: 3, any_dnf: 2, dnf_count: 5, dnf_driver: 0 });
  });

  test("DNF drivers: 8 points if he started in the real top 8, 4 if not, 0 if he did not retire", function () {
    // Two retirements: d03 (started in the real top 8) and d20 (did not).
    const actual = { top8: ids(1, 8), fastest_lap: "d02", dnf_drivers: ["d03", "d20"], grid_top8: ids(1, 8) };
    const picks = {
      // top 8: d01 d02 exact (10); d04 d05 d06 in the top 8 in other places (6); d21 d22 d23 outside (0)
      top8: ["d01", "d02", "d04", "d05", "d06", "d21", "d22", "d23"],
      fastest_lap: "d09", // wrong: 0
      any_dnf: true,      // right: 2
      dnf_count: 2,       // exact: 5
      dnf_drivers: ["d03", "d20", "d11"] // 8 + 4 + 0
    };
    const r = engine.explain("race", picks, actual);
    expect(r.components).toEqual({ exact: 10, in_top8: 6, bonus: 0, fastest_lap: 0, any_dnf: 2, dnf_count: 5, dnf_driver: 12 });
    expect(r.total).toBe(10 + 6 + 2 + 5 + 12);
  });

  test("the number of DNFs: exact 5, off by one 2, off by two or more 0", function () {
    const one = { top8: ids(1, 8), fastest_lap: "d01", dnf_drivers: ["d20"], grid_top8: ids(1, 8) };
    const base = { top8: [], fastest_lap: null, any_dnf: true, dnf_drivers: [] };
    expect(engine.explain("race", Object.assign({}, base, { dnf_count: 1 }), one).components.dnf_count).toBe(5);
    expect(engine.explain("race", Object.assign({}, base, { dnf_count: 2 }), one).components.dnf_count).toBe(2);
    expect(engine.explain("race", Object.assign({}, base, { dnf_count: 3 }), one).components.dnf_count).toBe(0);
  });

  test("any DNF: 2 points only when the yes/no answer is right", function () {
    const two = { top8: [], fastest_lap: null, dnf_drivers: ["d20", "d21"], grid_top8: [] };
    expect(engine.explain("race", { any_dnf: false, dnf_count: 0 }, two).components.any_dnf).toBe(0);
    expect(engine.explain("race", { any_dnf: true, dnf_count: 0 }, two).components.any_dnf).toBe(2);
    expect(engine.explain("race", { any_dnf: false, dnf_count: 0 }, R_NO_DNF).components.any_dnf).toBe(2);
    expect(engine.explain("race", { any_dnf: true, dnf_count: 0 }, R_NO_DNF).components.any_dnf).toBe(0);
  });

  test("the old single dnf_driver field still scores", function () {
    const actual = { top8: ids(1, 8), fastest_lap: "d01", dnf_drivers: ["d03"], grid_top8: ids(1, 8) };
    const picks = { top8: [], fastest_lap: null, any_dnf: true, dnf_count: 1, dnf_driver: "d03" };
    expect(engine.explain("race", picks, actual).components.dnf_driver).toBe(8);
  });

  test("fastest lap: 3 points for the right driver, nothing if no pick was made", function () {
    expect(engine.explain("race", { fastest_lap: "d01", any_dnf: false, dnf_count: 0 }, R_NO_DNF).components.fastest_lap).toBe(3);
    expect(engine.explain("race", { fastest_lap: "d02", any_dnf: false, dnf_count: 0 }, R_NO_DNF).components.fastest_lap).toBe(0);
    expect(engine.explain("race", { fastest_lap: null, any_dnf: false, dnf_count: 0 }, { top8: [], fastest_lap: null, dnf_drivers: [] }).components.fastest_lap).toBe(0);
  });

  test("seven exact positions do not earn the 15-point bonus", function () {
    const picks = { top8: ["d01", "d02", "d03", "d04", "d05", "d06", "d07", "d20"], fastest_lap: null, any_dnf: false, dnf_count: 0 };
    expect(engine.explain("race", picks, R_NO_DNF).components.bonus).toBe(0);
  });
});

// ---------------------------------------------------------------- Shape of the result (used by scorecard.js)
test.describe("explanation output", function () {
  test("the total always equals the sum of the section subtotals", function () {
    const picks = { top8: ["d01", "d02", "d04", "d05", "d06", "d21", "d22", "d23"], fastest_lap: "d01", any_dnf: true, dnf_count: 2, dnf_drivers: ["d03", "d20"] };
    const actual = { top8: ids(1, 8), fastest_lap: "d01", dnf_drivers: ["d03", "d20"], grid_top8: ids(1, 8) };
    const r = engine.explain("race", picks, actual);
    const sum = r.sections.reduce(function (t, s) { return t + s.subtotal; }, 0);
    expect(sum).toBe(r.total);
  });

  test("it never throws on missing or null input", function () {
    for (const type of ["qualifying", "sprint_qualifying", "sprint", "race"]) {
      expect(function () { engine.explain(type, null, null); }).not.toThrow();
      expect(function () { engine.explain(type, {}, {}); }).not.toThrow();
    }
  });
});
