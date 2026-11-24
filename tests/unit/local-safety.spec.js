// Lights Out: the safety rules that keep browser tests away from production (T4). No browser, no network.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const env = require("../fixtures/local-env");

test.describe("local environment guard", function () {
  test("accepts only plain http on this computer", function () {
    for (const ok of ["http://127.0.0.1:54321", "http://localhost:54321", "http://127.0.0.1:9999"]) {
      expect(function () { env.assertLocalUrl(ok); }, ok).not.toThrow();
    }
  });

  test("refuses production, other computers, https and nonsense", function () {
    const bad = ["https://abcdefghij.supabase.co", "http://abcdefghij.supabase.co", "https://127.0.0.1:54321",
      "http://192.168.1.20:54321", "http://example.com", "http://127.0.0.1.evil.com", "not a url", ""];
    for (const value of bad) {
      expect(function () { env.assertLocalUrl(value); }, JSON.stringify(value)).toThrow(/SAFETY/);
    }
  });

  test("the default local URL and key are not the production ones", function () {
    expect(function () { env.assertLocalUrl(env.LOCAL_URL); }).not.toThrow();
    expect(function () { env.assertNotProductionKey(env.LOCAL_KEY); }).not.toThrow();
    const prod = env.productionKey();
    expect(prod, "config.js must still hold the production publishable key").toBeTruthy();
    expect(env.LOCAL_KEY).not.toBe(prod);
    expect(function () { env.assertNotProductionKey(prod); }).toThrow(/SAFETY/);
    expect(function () { env.assertNotProductionKey(""); }).toThrow(/SAFETY/);
  });

  test("the local config contains no production address or key", function () {
    const app = fs.readFileSync(path.join(__dirname, "..", "fixtures", "app.js"), "utf8");
    expect(app).not.toMatch(/\.supabase\.co(?![A-Za-z0-9])/);
    expect(env.LOCAL_URL).not.toMatch(/supabase\.co/);
  });
});
