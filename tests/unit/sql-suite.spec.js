// Lights Out: guards for the local SQL test suite (T3.2).
// No Docker, no database, no network: these tests only read files.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const repo = path.join(__dirname, "..", "..");
const sqlTestsDir = path.join(repo, "supabase", "tests");
const runner = fs.readFileSync(path.join(repo, "tests", "db", "run-sql-tests.ps1"), "utf8");
const seed = fs.readFileSync(path.join(repo, "tests", "db", "seed.sql"), "utf8");

function retiredNumbers() {
  const block = runner.match(/\$Retired\s*=\s*\[ordered\]@\{([\s\S]*?)\n\}/);
  expect(block, "the $Retired block must exist in run-sql-tests.ps1").not.toBeNull();
  const numbers = [];
  const re = /"(\d{3})"\s*=/g;
  let m;
  while ((m = re.exec(block[1])) !== null) { numbers.push(m[1]); }
  return numbers;
}

test.describe("SQL regression suite (local runner)", function () {
  test("exactly the three legacy tests 005, 007 and 009 are retired, and the files still exist", function () {
    expect(retiredNumbers()).toEqual(["005", "007", "009"]);
    const files = fs.readdirSync(sqlTestsDir);
    for (const number of retiredNumbers()) {
      expect(files.some(function (f) { return f.startsWith(number + "_"); }), "retired test " + number + " must not be deleted").toBe(true);
    }
  });

  test("every SQL test file is numbered like its migration and ends with _test.sql", function () {
    const sqlFiles = fs.readdirSync(sqlTestsDir).filter(function (f) { return f.endsWith(".sql"); });
    expect(sqlFiles.length).toBeGreaterThan(0);
    for (const f of sqlFiles) { expect(f, f).toMatch(/^\d{3}_.+_test\.sql$/); }
  });
});

test.describe("local test seed", function () {
  test("cannot schedule jobs or reach a production address", function () {
    expect(seed).not.toMatch(/cron\.schedule|net\.http_|\.supabase\.co(?![A-Za-z0-9])/);
  });

  test("uses only made-up users (@lightsout.test), never real e-mail addresses", function () {
    const emails = seed.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+/g) || [];
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) { expect(e, e).toMatch(/@lightsout\.test$/); }
  });

  test("creates one admin and three players and checks its own result", function () {
    expect((seed.match(/@lightsout\.test/g) || []).length).toBe(4);
    expect(seed).toContain("Seed check failed");
    expect(seed.trimEnd().endsWith("commit;")).toBe(true);
  });
});
