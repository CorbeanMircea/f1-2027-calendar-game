// Lights Out: where the browser tests that need a database find it, and the rules that keep them away from production.
// The default URL and key are the throw-away values every local Supabase stack uses (printed by "npm run db:status").
// They can be overridden with LO_LOCAL_SUPABASE_URL and LO_LOCAL_SUPABASE_KEY.
const fs = require("fs");
const path = require("path");

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
const LOCAL_URL = process.env.LO_LOCAL_SUPABASE_URL || "http://127.0.0.1:54321";
const LOCAL_KEY = process.env.LO_LOCAL_SUPABASE_KEY || "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const LOCAL_INVITE_CODE = "LO-SEED-CODE-1"; // created by tests/db/seed.sql

// Refuses anything that is not plain http on this computer. Production is https on supabase.co, so it can never pass.
function assertLocalUrl(value) {
  let url;
  try { url = new URL(value); } catch (e) { throw new Error("SAFETY: not a valid Supabase URL: " + value); }
  if (url.protocol !== "http:" || LOCAL_HOSTS.indexOf(url.hostname) === -1) {
    throw new Error("SAFETY: refusing to run browser tests against a non-local Supabase URL: " + value);
  }
}

// The production publishable key is in the website's own config.js. Tests must never be given it.
function productionKey() {
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "config.js"), "utf8");
    const match = source.match(/SUPABASE_PUBLISHABLE_KEY\s*:\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function assertNotProductionKey(key) {
  const prod = productionKey();
  if (!key || (prod && key === prod)) {
    throw new Error("SAFETY: refusing to run browser tests with the production publishable key.");
  }
}

module.exports = { LOCAL_HOSTS, LOCAL_URL, LOCAL_KEY, LOCAL_INVITE_CODE, assertLocalUrl, assertNotProductionKey, productionKey };
