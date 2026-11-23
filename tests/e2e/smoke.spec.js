// Lights Out: T1 smoke tests.
// They check that the site is served, that every page file and the files it uses exist, and that the home page
// and the main navigation work in a real browser. No database, no sign-in, no production access.
const { test, expect } = require("../fixtures/base");

const PAGES = [
  "index.html", "predict.html", "leaderboard.html", "scorecard.html", "picks.html", "account.html",
  "admin.html", "how-to-play.html", "credits.html", "badges.html", "reset-password.html"
];

const EXTRA_FILES = [
  "config.js", "site-nav.js", "nav-badge.js", "sw.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png", "icons/favicon.png"
];

function localReferences(html) {
  const found = [];
  const patterns = [/<script[^>]*\ssrc="([^"]+)"/gi, /<link[^>]*\shref="([^"]+)"/gi];
  patterns.forEach(function (re) {
    let m;
    while ((m = re.exec(html)) !== null) { found.push(m[1]); }
  });
  return found
    .filter(function (ref) { return !/^(https?:|data:|mailto:|#|\/\/)/i.test(ref); })
    .map(function (ref) { return ref.split("?")[0].split("#")[0]; })
    .filter(function (ref) { return ref.length > 0; });
}

test.describe("static files (no browser)", function () {
  for (const file of PAGES) {
    test("page is served: " + file, async function ({ request }) {
      const res = await request.get("/" + file);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/html");
    });
  }

  for (const file of EXTRA_FILES) {
    test("file is served: " + file, async function ({ request }) {
      const res = await request.get("/" + file);
      expect(res.status()).toBe(200);
    });
  }

  for (const file of PAGES) {
    test("scripts and stylesheets exist: " + file, async function ({ request }) {
      const html = await (await request.get("/" + file)).text();
      const refs = localReferences(html);
      expect(refs.length).toBeGreaterThan(0);
      const missing = [];
      for (const ref of refs) {
        const res = await request.get("/" + ref);
        if (res.status() !== 200) { missing.push(ref + " (" + res.status() + ")"); }
      }
      expect(missing, "files referenced by " + file + " but not found").toEqual([]);
    });
  }

  test("the web manifest is valid and its icons exist", async function ({ request }) {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe("index.html");
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const iconRes = await request.get("/" + icon.src);
      expect(iconRes.status(), icon.src).toBe(200);
    }
  });

  test("hidden and private files are not served", async function ({ request }) {
    // /.gitignore and the Playwright package file both exist on disk, so a 404 proves the server hides them.
    for (const blocked of ["/.gitignore", "/.git/config", "/node_modules/@playwright/test/package.json"]) {
      const res = await request.get(blocked);
      expect(res.status(), blocked).toBe(404);
    }
  });
});

test.describe("home page (browser)", function () {
  test("loads with the expected title, sections and footer", async function ({ page }) {
    await page.goto("/index.html");
    await expect(page).toHaveTitle(/Lights Out/);
    await expect(page.locator("#schedule-title")).toHaveText("Schedule");
    await expect(page.locator("#standings-title")).toHaveText("Standings");
    await expect(page.locator("footer.site-footer a", { hasText: "How to play" })).toBeVisible();
  });

  test("the top navigation lists every page and marks Home as current", async function ({ page }) {
    await page.goto("/index.html");
    const nav = page.locator("nav.lo-nav");
    await expect(nav).toBeVisible();
    for (const label of ["Home", "Predictions", "Leaderboard", "Score check", "Account", "Rules"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
  });

  test("the Admin link stays hidden when nobody is signed in", async function ({ page }) {
    await page.goto("/index.html");
    await expect(page.locator("#admin-link")).toBeHidden();
  });

  test("the Rules link opens the How to play page", async function ({ page }) {
    await page.goto("/index.html");
    await page.locator("nav.lo-nav").getByRole("link", { name: "Rules", exact: true }).click();
    await expect(page).toHaveURL(/how-to-play\.html$/);
    await expect(page).toHaveTitle(/How to play/);
    await expect(page.locator("h1.pg-title")).toContainText("How to play");
    await expect(page.getByRole("heading", { level: 2, name: "Deadlines", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Scoring", exact: true })).toBeVisible();
  });
});

test.describe("every page opens (browser)", function () {
  for (const file of PAGES) {
    test("opens without leaving the page: " + file, async function ({ page }, testInfo) {
      const errors = [];
      page.on("pageerror", function (err) { errors.push(err.message); });

      const res = await page.goto("/" + file);
      expect(res.status()).toBe(200);
      await expect(page.locator("nav.lo-nav")).toBeAttached();

      // Information only (does not fail the test): script errors the page raised while Supabase is unreachable.
      // They show up in the HTML report so we can decide later which ones matter.
      errors.forEach(function (message) {
        testInfo.annotations.push({ type: "page script error", description: message });
      });
    });
  }
});
