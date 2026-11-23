// Lights Out: shared test setup. Import { test, expect } from here instead of "@playwright/test".
//
// Safety rules applied to every browser test:
//   1. config.js is replaced with a fake one, so the site can never reach the production Supabase project.
//   2. Every request to a website other than the local server (and the one script CDN the site uses) is blocked.
//   3. If anything still tried to reach supabase.co / supabase.in, the test FAILS loudly.
const base = require("@playwright/test");

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];
const ALLOWED_EXTERNAL_HOSTS = ["cdn.jsdelivr.net"]; // supabase-js is loaded from here by every page

// Nothing is listening here, so any request the site makes to "Supabase" simply fails.
const FAKE_CONFIG =
  "window.APP_CONFIG = {\n" +
  "  SUPABASE_URL: \"http://127.0.0.1:65500\",\n" +
  "  SUPABASE_PUBLISHABLE_KEY: \"test-key-not-a-real-key\",\n" +
  "  VAPID_PUBLIC_KEY: \"\"\n" +
  "};\n";

function isLocalConfig(url) {
  return LOCAL_HOSTS.indexOf(url.hostname) !== -1 && url.pathname.slice(-"/config.js".length) === "/config.js";
}

function isBlockedExternal(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") { return false; }
  if (LOCAL_HOSTS.indexOf(url.hostname) !== -1) { return false; }
  return ALLOWED_EXTERNAL_HOSTS.indexOf(url.hostname) === -1;
}

const test = base.test.extend({
  context: async function ({ context }, use) {
    const blocked = [];

    await context.route(isLocalConfig, function (route) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_CONFIG });
    });

    await context.route(isBlockedExternal, function (route) {
      blocked.push(route.request().url());
      return route.abort();
    });

    await use(context);

    const tried = blocked.filter(function (u) { return /supabase\.(co|in)/i.test(u); });
    if (tried.length > 0) {
      throw new Error("SAFETY: the page tried to reach Supabase (blocked): " + tried.join(", "));
    }
  }
});

module.exports = { test, expect: base.expect, FAKE_CONFIG };
