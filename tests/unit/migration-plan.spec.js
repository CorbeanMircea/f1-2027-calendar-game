// Lights Out: guards for the local database replay (T3.1).
// They protect one rule: the local test database must never schedule jobs or call a production service.
// No Docker, no database, no network: these tests only read files.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const repo = path.join(__dirname, "..", "..");
const migrationsDir = path.join(repo, "supabase");
const script = fs.readFileSync(path.join(repo, "tests", "db", "apply-migrations.ps1"), "utf8");
const config = fs.readFileSync(path.join(repo, "tests", "db", "supabase", "config.toml"), "utf8");

const FORBIDDEN = /cron\.schedule|net\.http_|\.supabase\.co(?![A-Za-z0-9])/;

function migrationFiles() {
  return fs.readdirSync(migrationsDir).filter(function (name) { return /^\d{3}_.+\.sql$/.test(name); }).sort();
}

function excludedNumbers() {
  const block = script.match(/\$Excluded\s*=\s*\[ordered\]@\{([\s\S]*?)\n\}/);
  expect(block, "the $Excluded block must exist in apply-migrations.ps1").not.toBeNull();
  const numbers = [];
  const re = /"(\d{3})"\s*=/g;
  let m;
  while ((m = re.exec(block[1])) !== null) { numbers.push(m[1]); }
  return numbers;
}

test.describe("local migration replay plan", function () {
  test("exactly migrations 015 and 022 are excluded (approved Q7)", function () {
    expect(excludedNumbers()).toEqual(["015", "022"]);
  });

  test("every migration that WILL be applied is free of cron scheduling and production URLs", function () {
    const excluded = excludedNumbers();
    const offenders = migrationFiles().filter(function (name) {
      if (excluded.indexOf(name.slice(0, 3)) !== -1) { return false; }
      return FORBIDDEN.test(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
    });
    expect(offenders, "new migration needing review before it can be replayed locally").toEqual([]);
  });

  test("every excluded migration really needs excluding (so the list stays honest)", function () {
    for (const number of excludedNumbers()) {
      const name = migrationFiles().find(function (n) { return n.startsWith(number + "_"); });
      expect(name, "excluded migration " + number + " must exist").toBeTruthy();
      expect(FORBIDDEN.test(fs.readFileSync(path.join(migrationsDir, name), "utf8")), name).toBe(true);
    }
  });

  test("migration numbers are unique and the safety pattern in the script matches this test", function () {
    const numbers = migrationFiles().map(function (n) { return n.slice(0, 3); });
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(script).toContain("$ForbiddenPattern = 'cron\\.schedule|net\\.http_|\\.supabase\\.co(?![A-Za-z0-9])'");
  });
});

test.describe("local Supabase configuration", function () {
  test("matches production's PostgreSQL major version and keeps seeding explicit", function () {
    expect(config).toMatch(/^project_id = "lights-out-test"$/m);
    expect(config).toMatch(/^major_version = 17$/m);
    expect(config).toMatch(/\[db\.seed\]\n(?:#.*\n)*enabled = false/);
  });

  test("points nowhere near production and is not linked to any remote project", function () {
    expect(config).not.toMatch(/\.supabase\.co(?![A-Za-z0-9])/);
    expect(config).toContain('site_url = "http://127.0.0.1:4173"');
    const tempDir = path.join(repo, "tests", "db", "supabase", ".temp");
    for (const linked of ["project-ref", "linked-project.json", "pooler-url"]) {
      expect(fs.existsSync(path.join(tempDir, linked)), linked + " would mean the local folder was linked to a remote project").toBe(false);
    }
  });
});
