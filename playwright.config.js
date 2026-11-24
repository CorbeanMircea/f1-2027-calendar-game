// Lights Out: Playwright configuration (milestones T1, T2 and T4).
// Projects:
//   unit              Node-only tests of the pure scoring code and the safety rules (tests/unit). No browser, no network.
//   chromium-desktop  Browser smoke tests (tests/e2e) against a local copy of the site. No database needed.
//   chromium-local    Browser tests (tests/e2e-local) against the site AND the local Supabase stack in Docker.
//   local-setup       Checks the local stack is ready before chromium-local runs.
// Nothing here talks to production.
// The site is plain static files, so browser tests serve the repository folder with a tiny local server
// (tests/tools/static-server.js) on 127.0.0.1.
const { defineConfig, devices } = require("@playwright/test");

const PORT = Number(process.env.LO_TEST_PORT || 4173);
const BASE_URL = "http://127.0.0.1:" + PORT;
const IN_CI = !!process.env.CI;

module.exports = defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",

  fullyParallel: true,
  forbidOnly: IN_CI,
  retries: IN_CI ? 1 : 0,
  workers: IN_CI ? 2 : undefined,

  timeout: 30 * 1000,
  expect: { timeout: 7 * 1000 },

  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  use: {
    baseURL: BASE_URL,
    // A fixed locale and time zone keep date and time text the same on every machine.
    locale: "en-GB",
    timezoneId: "UTC",
    // The site's service worker is tested later, on purpose. Blocking it here makes sure every
    // request goes through the safety rules in tests/fixtures/base.js.
    serviceWorkers: "block",
    // Evidence is kept only when a test fails.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },

  projects: [
    { name: "unit", testDir: "./tests/unit" },
    { name: "chromium-desktop", testDir: "./tests/e2e", use: { ...devices["Desktop Chrome"] } },

    // Browser tests that need the LOCAL Supabase stack in Docker (npm run db:start, then npm run db:fresh).
    // "local-setup" runs first and stops with a clear message if the stack is not ready.
    { name: "local-setup", testDir: "./tests/e2e-local", testMatch: /local\.setup\.js$/ },
    {
      name: "chromium-local",
      testDir: "./tests/e2e-local",
      testMatch: /.*\.spec\.js$/,
      dependencies: ["local-setup"],
      use: { ...devices["Desktop Chrome"] }
    }
  ],

  webServer: {
    command: "node tests/tools/static-server.js " + PORT,
    url: BASE_URL + "/index.html",
    reuseExistingServer: !IN_CI,
    timeout: 20 * 1000,
    stdout: "ignore",
    stderr: "pipe"
  }
});
