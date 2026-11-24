// Lights Out: test setup for browser tests that talk to the LOCAL Supabase stack. Import { test, expect } from here.
//
// It builds on tests/fixtures/base.js (every external site except the script CDN stays blocked, and any attempt to reach
// supabase.co still fails the test) and replaces config.js with one that points at the local stack in Docker.
const base = require("./base");
const { LOCAL_HOSTS, LOCAL_URL, LOCAL_KEY, assertLocalUrl, assertNotProductionKey } = require("./local-env");

const LOCAL_CONFIG =
  "window.APP_CONFIG = {\n" +
  "  SUPABASE_URL: " + JSON.stringify(LOCAL_URL) + ",\n" +
  "  SUPABASE_PUBLISHABLE_KEY: " + JSON.stringify(LOCAL_KEY) + ",\n" +
  "  VAPID_PUBLIC_KEY: \"\"\n" +
  "};\n";

function isConfigRequest(url) {
  return LOCAL_HOSTS.indexOf(url.hostname) !== -1 && url.pathname.slice(-"/config.js".length) === "/config.js";
}

const test = base.test.extend({
  context: async function ({ context }, use) {
    assertLocalUrl(LOCAL_URL);
    assertNotProductionKey(LOCAL_KEY);
    await context.route(isConfigRequest, function (route) {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: LOCAL_CONFIG });
    });
    await use(context);
  }
});

module.exports = { test, expect: base.expect, LOCAL_CONFIG };
