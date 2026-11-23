// Lights Out: late-entry rounding (T2).
// A late Race or Sprint prediction counts at 70% of its points, rounded DOWN. The database does this in exact
// arithmetic: floor(raw_total * 0.7) with a numeric 0.7 (migration 039, lo_score). scorecard.js repeats the
// calculation in the browser for the "Score check" page (scorecard.js, the "Late entry" row).
// No browser, no network, no database.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

// The exact answer, using whole numbers only (what the database returns).
function exactLate(raw, factor) {
  return Math.floor((raw * Math.round(factor * 100)) / 100);
}

// What scorecard.js did BEFORE the fix ("var lateCalc = Math.floor(calc.total * factor);").
function oldBrowserLate(raw, factor) {
  return Math.floor(raw * factor);
}

// What scorecard.js does now: round away the tiny floating-point error first.
function fixedLate(raw, factor) {
  return Math.floor(Math.round(raw * factor * 1e6) / 1e6);
}

test.describe("late entry: the database rule (exact arithmetic)", function () {
  test("known values, including the ones pinned by the SQL test for migration 039", function () {
    const table = [[0, 0], [10, 7], [32, 22], [45, 31], [62, 43], [65, 45], [73, 51], [90, 63], [105, 73]];
    for (const [raw, expected] of table) {
      expect(exactLate(raw, 0.7), "raw " + raw).toBe(expected);
    }
  });
});

test.describe("late entry: the browser formula in scorecard.js", function () {
  test("the OLD formula Math.floor(total * 0.7) was one point too low for some totals (documents why the fix exists)", function () {
    const wrong = [];
    for (let raw = 0; raw <= 200; raw++) {
      if (oldBrowserLate(raw, 0.7) !== exactLate(raw, 0.7)) { wrong.push(raw); }
    }
    // The only total a Race can really reach in this list is 90 (maximum 65 plus 8 per DNF driver picked).
    expect(wrong).toEqual([90, 170, 180]);
    expect(oldBrowserLate(90, 0.7)).toBe(62); // floating point gives 62.99999999999999
    expect(exactLate(90, 0.7)).toBe(63);          // the database stores 63
  });

  test("scorecard.js uses the protected formula, not the unprotected one", function () {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "scorecard.js"), "utf8");
    expect(source).not.toMatch(/Math\.floor\(\s*calc\.total\s*\*\s*factor\s*\)/);
    expect(source).toContain("Math.floor(Math.round(calc.total * factor * 1e6) / 1e6)");
  });
});

test.describe("late entry: the fixed formula", function () {
  test("matches the exact result for every total from 0 to 1000", function () {
    for (const factor of [0.7]) {
      for (let raw = 0; raw <= 1000; raw++) {
        expect(fixedLate(raw, factor), "raw " + raw + " at " + factor).toBe(exactLate(raw, factor));
      }
    }
  });

  test("also works for other two-decimal factors, in case the late factor is ever changed", function () {
    for (const factor of [0.5, 0.6, 0.75, 0.8, 0.85, 0.9]) {
      for (let raw = 0; raw <= 1000; raw++) {
        expect(fixedLate(raw, factor), "raw " + raw + " at " + factor).toBe(exactLate(raw, factor));
      }
    }
  });

  test("fixes every total the current formula gets wrong", function () {
    for (const raw of [90, 170, 180]) {
      expect(fixedLate(raw, 0.7)).toBe(exactLate(raw, 0.7));
    }
  });
});
