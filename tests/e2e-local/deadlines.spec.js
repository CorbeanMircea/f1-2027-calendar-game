// Lights Out: deadlines, the deadline lights and locking, as a player sees them (T7, browser tests against the LOCAL stack).
// The weekend is a private test event created for this file; each test moves its session start times, then reloads the page.
// What the lights say (predict-lights.js): "Predictions open", "Predictions lock soon" (under 24 h), "Full value ends soon"
// (Race/Sprint, Qualifying under 24 h away), "Late entry: counts at 70%" (Qualifying has started), "Predictions locked".
const { test, expect } = require("../fixtures/app");
const { Api } = require("../fixtures/api");
const p = require("../fixtures/predict");
const t = require("../fixtures/test-event");

test.describe.configure({ mode: "default" });

let api;
let event;
let quali;
let race;

test.beforeAll(async function () {
  api = await Api.create();
  event = t.createTestEvent("lights", { qualifying: "now() + interval '3 days'", race: "now() + interval '4 days'" });
  quali = { id: event.sessions.qualifying, eventId: event.id };
  race = { id: event.sessions.race, eventId: event.id };
});

test.afterAll(async function () {
  t.deleteTestEvent(event);
  await api.dispose();
});

async function member(context, label) {
  const user = await api.createMember(label);
  await p.loginAs(context, user);
  return user;
}

function lights(page) {
  return {
    box: page.locator("#deadline-lights"),
    state: page.locator("#dl-state"),
    time: page.locator("#dl-time"),
    lit: page.locator("#deadline-lights .dl-light.is-lit")
  };
}

test.describe("the deadline lights", function () {
  test("Qualifying, more than a day away: open, two lights", async function ({ page, context }) {
    await member(context, "open");
    t.setStart(quali.id, "now() + interval '3 days'");
    await p.openSession(page, quali);
    const l = lights(page);
    await expect(l.box).toHaveAttribute("data-state", "open");
    await expect(l.state).toHaveText("Predictions open");
    await expect(l.time).toContainText("Locks in");
    await expect(l.lit).toHaveCount(2);
  });

  test("Qualifying, under a day away: lock soon, four lights", async function ({ page, context }) {
    await member(context, "soon");
    t.setStart(quali.id, "now() + interval '5 hours'");
    await p.openSession(page, quali);
    const l = lights(page);
    await expect(l.box).toHaveAttribute("data-state", "soon");
    await expect(l.state).toHaveText("Predictions lock soon");
    await expect(l.lit).toHaveCount(4);
  });

  test("Race, with Qualifying under a day away: full value ends soon", async function ({ page, context }) {
    await member(context, "fullsoon");
    t.setStart(quali.id, "now() + interval '20 hours'");
    t.setStart(race.id, "now() + interval '2 days'");
    await p.openSession(page, race);
    const l = lights(page);
    await expect(l.box).toHaveAttribute("data-state", "soon");
    await expect(l.state).toHaveText("Full value ends soon");
    await expect(l.time).toContainText("Full value for");
    await expect(l.lit).toHaveCount(3);
  });

  test("Race, after Qualifying has started: late entry at 70%", async function ({ page, context }) {
    await member(context, "late");
    t.setStart(quali.id, "now() - interval '1 hour'");
    t.setStart(race.id, "now() + interval '1 day'");
    await p.openSession(page, race);
    const l = lights(page);
    await expect(l.box).toHaveAttribute("data-state", "late");
    await expect(l.state).toHaveText("Late entry: counts at 70%");
    await expect(l.time).toContainText("Closes in");
  });

  test("Race with no confirmed Qualifying time: open and never late, and Qualifying is not offered", async function ({ page, context }) {
    await member(context, "tbc");
    t.setStart(quali.id, "null");
    t.setStart(race.id, "now() + interval '3 days'");
    await p.openSession(page, race);
    const l = lights(page);
    await expect(l.box).toHaveAttribute("data-state", "open");
    await expect(l.state).toHaveText("Predictions open");
    await expect(page.locator('.pl-sess[data-id="' + quali.id + '"]')).toHaveCount(0);
  });
});

test.describe("locking", function () {
  test("a form that is open when the page loads locks itself at the deadline", async function ({ page, context }) {
    test.setTimeout(60000);
    await member(context, "livelock");
    t.setStart(quali.id, "now() + interval '14 seconds'");
    await p.openSession(page, quali);
    await expect(page.locator("#save-button")).toBeEnabled();
    await expect(page.locator("#pick-status")).toHaveText("Step 1: 0 of 6 chosen");

    await expect(page.locator("#pick-status")).toHaveText("Predictions locked", { timeout: 30000 });
    await expect(page.locator("#pred-message")).toHaveText("Predictions are locked for this session. Your saved picks cannot be changed.");
    await expect(page.locator("#save-button")).toBeDisabled();
    await expect(p.driver(p.step(page, "Step 1"), "str")).toBeDisabled();
  });

  async function fillQualifyingAndPassTheDeadline(page, context, label) {
    const user = await member(context, label);
    t.setStart(quali.id, "now() + interval '1 hour'");
    await p.openSession(page, quali);
    await p.tap(p.step(page, "Step 1"), ["str", "per", "sai", "oco", "law", "bot"]);
    await p.tap(p.step(page, "Step 2"), ["col", "gas", "hul", "bea", "lin", "bor"]);
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");
    t.setStart(quali.id, "now() - interval '1 minute'"); // the deadline passes while the page is still open
    return user;
  }

  test("a save that arrives after the deadline is refused by the server, and nothing is stored", async function ({ page, context }) {
    const user = await fillQualifyingAndPassTheDeadline(page, context, "toolate");
    const answer = page.waitForResponse(function (res) { return res.url().indexOf("/rpc/submit_prediction") !== -1; });
    await p.save(page);
    const response = await answer;
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect((await response.json()).message).toBe("Predictions are closed for this session");

    const stored = await api.get("predictions", "select=id&user_id=eq." + user.id + "&session_id=eq." + quali.id, user.token);
    expect(stored.body).toEqual([]);
  });

  test("the player is still told why the save failed, after the page has refreshed its list of open sessions", async function ({ page, context }) {
    // Regression guard: after a refused save the page reloads the list of open sessions, and the explanation must survive that
    // (it used to be wiped about 0.3 s after it appeared; fixed in predict-tiles.js by showing the message again after the reload).
    await fillQualifyingAndPassTheDeadline(page, context, "explain");
    await p.save(page);
    await expect(page.locator('.pl-sess[data-id="' + quali.id + '"]')).toHaveCount(0); // the page has refreshed its list
    await expect(page.locator("#pick-status")).not.toHaveText(/^(|Ready to save)$/);    // ...and has built the next session's form
    await p.expectError(page, "Predictions are closed for this session");
  });

  test("a locked session is no longer offered for new predictions", async function ({ page, context }) {
    await member(context, "gone");
    t.setStart(quali.id, "now() - interval '1 minute'");
    t.setStart(race.id, "now() + interval '1 day'");
    await page.goto("/predict.html");
    await expect(page.locator("#form-area")).toBeVisible();
    await expect(page.locator('.pl-sess[data-id="' + quali.id + '"]')).toHaveCount(0);
  });
});

test.describe("a late entry made in the browser", function () {
  test("the Race form is still usable after Qualifying, and the saved prediction is dated after it", async function ({ page, context }) {
    const user = await member(context, "latesave");
    t.setStart(quali.id, "now() - interval '1 hour'");
    t.setStart(race.id, "now() + interval '1 day'");
    await p.openSession(page, race);
    await expect(lights(page).state).toHaveText("Late entry: counts at 70%");

    const top8 = ["nor", "pia", "ver", "ham", "lec", "rus", "ant", "alo"];
    await p.tap(p.step(page, "Top 8"), top8);
    await p.tap(p.step(page, "Fastest lap"), ["nor"]);
    await page.getByRole("button", { name: "No", exact: true }).click();
    await p.save(page);
    await p.expectSaved(page);

    const row = (await api.get("predictions", "select=created_at,updated_at&user_id=eq." + user.id + "&session_id=eq." + race.id, user.token)).body[0];
    const start = Date.parse(t.startOf(quali.id));
    expect(Date.parse(row.created_at), "saved after Qualifying started: it will count as a late entry").toBeGreaterThanOrEqual(start);
  });
});
