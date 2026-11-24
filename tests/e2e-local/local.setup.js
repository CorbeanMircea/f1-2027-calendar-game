// Lights Out: runs once before the local browser tests. It stops early, with a clear message, if the local Supabase stack
// is not running or has not been rebuilt, instead of letting every test fail in a confusing way.
const { test, expect } = require("@playwright/test");
const { LOCAL_URL, LOCAL_KEY, assertLocalUrl, assertNotProductionKey } = require("../fixtures/local-env");

test("the local Supabase stack is running and has the Lights Out database", async function ({ request }) {
  assertLocalUrl(LOCAL_URL);
  assertNotProductionKey(LOCAL_KEY);
  const hint = " Start the stack with: npm run db:start   and build the database with: npm run db:fresh";
  const headers = { apikey: LOCAL_KEY };

  let health;
  try {
    health = await request.get(LOCAL_URL + "/auth/v1/health", { headers: headers });
  } catch (e) {
    throw new Error("Cannot reach the local Supabase stack at " + LOCAL_URL + "." + hint);
  }
  expect(health.status(), "the local sign-in service is not healthy." + hint).toBe(200);

  const events = await request.get(LOCAL_URL + "/rest/v1/events?select=id&limit=1", { headers: headers });
  expect(events.ok(), "the local database API did not answer." + hint).toBe(true);
  const rows = await events.json();
  expect(Array.isArray(rows) && rows.length > 0, "the local database has no events (not replayed yet)." + hint).toBe(true);
});
