// Lights Out: lock wording on the home page (T3a).
// Since migration 039 every session locks when IT starts. The home page schedule note must never say that a Race or
// Sprint locks "when Qualifying starts" (the old rule). This is a source check; a browser check with real session
// data follows once the local Supabase environment exists.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

test("home.js tells players a session locks when that session starts", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "home.js"), "utf8");
  expect(source).toContain("Predictions lock when this session starts");
  expect(source).not.toMatch(/Predictions lock when "\s*\+/);
  expect(source).not.toContain("LOCK_TYPE");
});
