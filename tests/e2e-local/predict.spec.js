// Lights Out: making predictions in the browser (T6, against the LOCAL Supabase stack).
// Each test makes its own made-up group member through the API, signs the browser in as them, and uses the real predictions page.
// The four forms (Sprint Qualifying, Sprint, Qualifying, Race) are opened by giving their sessions future start times in the
// local database. What is saved is always read back from the database, not just from the page.
const { test, expect } = require("../fixtures/app");
const { Api } = require("../fixtures/api");
const p = require("../fixtures/predict");

test.describe.configure({ mode: "default" }); // one worker: the tests share the four sessions below

let api;
let originals;

test.beforeAll(async function () {
  api = await Api.create();
  originals = p.openSessions();
});

test.afterAll(async function () {
  p.restoreSessions(originals);
  await api.dispose();
});

// A fresh group member, with the browser already signed in as them.
async function member(context, label) {
  const user = await api.createMember(label);
  await p.loginAs(context, user);
  return user;
}

const TOP8 = ["nor", "pia", "ver", "ham", "lec", "rus", "ant", "alo"];

test.describe("who may use the predictions page", function () {
  test("a visitor who is not signed in is asked to sign in", async function ({ page }) {
    await page.goto("/predict.html");
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#gate-text")).toHaveText("Please sign in on the Account page to make predictions.");
    await expect(page.locator("#predict-panel")).toBeHidden();
  });

  test("a signed-in player who has not joined the group is asked to join first", async function ({ page, context }) {
    const user = await api.signUp("nogroup");
    await p.loginAs(context, user);
    await page.goto("/predict.html");
    await expect(page.locator("#gate-text")).toHaveText("Join the friends group on the Account page first.");
    await expect(page.locator("#predict-panel")).toBeHidden();
  });
});

test.describe("qualifying", function () {
  test("the form starts at step 1 and refuses to save an unfinished prediction", async function ({ page, context }) {
    await member(context, "qstart");
    await p.openSession(page, p.SESSIONS.qualifying);
    await expect(page.locator("#pick-status")).toHaveText("Step 1: 0 of 6 chosen");

    const saves = [];
    page.on("request", function (req) { if (req.url().indexOf("/rpc/submit_prediction") !== -1) { saves.push(req.url()); } });
    await p.save(page);
    await p.expectError(page, "Please complete all three steps.");
    expect(saves, "nothing may be sent for an unfinished prediction").toEqual([]);
  });

  test("the steps unlock one after the other, and the Q3 order fills itself in", async function ({ page, context }) {
    await member(context, "qsteps");
    await p.openSession(page, p.SESSIONS.qualifying);

    await p.tap(p.step(page, "Step 1"), ["str", "per", "sai", "oco", "law", "bot"]);
    await expect(page.locator("#pick-status")).toHaveText("Step 2: 0 of 6 chosen");

    await p.tap(p.step(page, "Step 2"), ["col", "gas", "hul", "bea", "lin", "bor"]);
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");
    expect((await p.slotOrder(p.step(page, "Step 3"))).length).toBe(10);
  });

  test("a complete prediction saves, and the database holds exactly what was chosen", async function ({ page, context }) {
    const user = await member(context, "qsave");
    await p.openSession(page, p.SESSIONS.qualifying);
    const q1 = ["str", "per", "sai", "oco", "law", "bot"];
    const q2 = ["col", "gas", "hul", "bea", "lin", "bor"];
    await p.tap(p.step(page, "Step 1"), q1);
    await p.tap(p.step(page, "Step 2"), q2);
    const order = await p.slotOrder(p.step(page, "Step 3"));
    await p.save(page);
    await p.expectSaved(page);

    const picks = await p.savedPicks(api, user, p.SESSIONS.qualifying);
    expect(picks.q1_out.slice().sort()).toEqual(q1.map(p.driverId).sort());
    expect(picks.q2_out.slice().sort()).toEqual(q2.map(p.driverId).sort());
    expect(picks.q3_order).toEqual(order.map(p.driverId));
  });

  test("two Q3 positions can be swapped, and the new order is what gets saved", async function ({ page, context }) {
    const user = await member(context, "qswap");
    await p.openSession(page, p.SESSIONS.qualifying);
    await p.tap(p.step(page, "Step 1"), ["str", "per", "sai", "oco", "law", "bot"]);
    await p.tap(p.step(page, "Step 2"), ["col", "gas", "hul", "bea", "lin", "bor"]);
    const before = await p.slotOrder(p.step(page, "Step 3"));

    const slots = p.step(page, "Step 3").locator("button.slot");
    await slots.nth(0).click();
    await slots.nth(1).click();
    const after = await p.slotOrder(p.step(page, "Step 3"));
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);

    await p.save(page);
    await p.expectSaved(page);
    const picks = await p.savedPicks(api, user, p.SESSIONS.qualifying);
    expect(picks.q3_order).toEqual(after.map(p.driverId));
  });

  test("a saved prediction is still there after a reload, shown as saved", async function ({ page, context }) {
    const user = await member(context, "qreload");
    await p.openSession(page, p.SESSIONS.qualifying);
    await p.tap(p.step(page, "Step 1"), ["str", "per", "sai", "oco", "law", "bot"]);
    await p.tap(p.step(page, "Step 2"), ["col", "gas", "hul", "bea", "lin", "bor"]);
    const order = await p.slotOrder(p.step(page, "Step 3"));
    await p.save(page);
    await p.expectSaved(page);

    await p.openSession(page, p.SESSIONS.qualifying);
    await expect(page.locator("#pick-status")).toHaveText("Prediction saved");
    expect(await p.slotOrder(p.step(page, "Step 3"))).toEqual(order);
    await expect(page.locator('.pl-sess[data-id="' + p.SESSIONS.qualifying.id + '"]')).toContainText("Saved");
    expect(await p.savedPicks(api, user, p.SESSIONS.qualifying)).not.toBeNull();
  });

  test("a chosen driver can be taken out again, and the counter follows", async function ({ page, context }) {
    await member(context, "qundo");
    await p.openSession(page, p.SESSIONS.qualifying);
    const first = p.step(page, "Step 1");
    await p.tap(first, ["str", "per"]);
    await expect(page.locator("#pick-status")).toHaveText("Step 1: 2 of 6 chosen");
    await p.driver(first, "per").click();
    await expect(page.locator("#pick-status")).toHaveText("Step 1: 1 of 6 chosen");
    await expect(p.driver(first, "per")).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("sprint qualifying", function () {
  test("uses the same three steps and saves", async function ({ page, context }) {
    const user = await member(context, "sq");
    await p.openSession(page, p.SESSIONS.sprintQualifying);
    await expect(page.locator("#pick-fields h3").first()).toContainText("knocked out in SQ1");
    await p.tap(p.step(page, "Step 1"), ["str", "per", "sai", "oco", "law", "bot"]);
    await p.tap(p.step(page, "Step 2"), ["col", "gas", "hul", "bea", "lin", "bor"]);
    await p.save(page);
    await p.expectSaved(page);
    const picks = await p.savedPicks(api, user, p.SESSIONS.sprintQualifying);
    expect(picks.q1_out.length).toBe(6);
    expect(picks.q2_out.length).toBe(6);
    expect(picks.q3_order.length).toBe(10);
  });
});

test.describe("sprint", function () {
  test("the top 8 fill in the order the drivers are tapped, and save", async function ({ page, context }) {
    const user = await member(context, "sprint");
    await p.openSession(page, p.SESSIONS.sprint);
    await expect(page.locator("#pick-status")).toHaveText("0 of 8 selected");
    await p.tap(page.locator("#pick-fields"), TOP8);
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");
    expect(await p.slotOrder(page.locator("#pick-fields"))).toEqual(TOP8);

    await p.save(page);
    await p.expectSaved(page);
    const picks = await p.savedPicks(api, user, p.SESSIONS.sprint);
    expect(picks.top8).toEqual(TOP8.map(p.driverId));
  });

  test("seven drivers are not enough", async function ({ page, context }) {
    const user = await member(context, "sprint7");
    await p.openSession(page, p.SESSIONS.sprint);
    await p.tap(page.locator("#pick-fields"), TOP8.slice(0, 7));
    await expect(page.locator("#pick-status")).toHaveText("7 of 8 selected");
    await p.save(page);
    await p.expectError(page, "Please choose a driver for every position.");
    expect(await p.savedPicks(api, user, p.SESSIONS.sprint)).toBeNull();
  });

  test("a driver can be removed with the cross, and two positions can be swapped", async function ({ page, context }) {
    const user = await member(context, "sprintedit");
    await p.openSession(page, p.SESSIONS.sprint);
    await p.tap(page.locator("#pick-fields"), TOP8);
    await page.getByRole("button", { name: "Remove " + p.DRIVERS.alo + " from position 8" }).click();
    await expect(page.locator("#pick-status")).toHaveText("7 of 8 selected");
    await p.driver(page.locator("#pick-fields"), "str").click();
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");

    const slots = page.locator("#pick-fields button.slot");
    await slots.nth(0).click();
    await slots.nth(7).click();
    const expected = TOP8.slice(0, 7).concat(["str"]);
    const swapped = [expected[7]].concat(expected.slice(1, 7), [expected[0]]);
    expect(await p.slotOrder(page.locator("#pick-fields"))).toEqual(swapped);

    await p.save(page);
    await p.expectSaved(page);
    expect((await p.savedPicks(api, user, p.SESSIONS.sprint)).top8).toEqual(swapped.map(p.driverId));
  });

  test("a saved prediction can be changed and saved again", async function ({ page, context }) {
    const user = await member(context, "sprintchange");
    await p.openSession(page, p.SESSIONS.sprint);
    await p.tap(page.locator("#pick-fields"), TOP8);
    await p.save(page);
    await p.expectSaved(page);

    const slots = page.locator("#pick-fields button.slot");
    await slots.nth(0).click();
    await slots.nth(1).click();
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");
    await p.save(page);
    await p.expectSaved(page);
    const swapped = [TOP8[1], TOP8[0]].concat(TOP8.slice(2));
    expect((await p.savedPicks(api, user, p.SESSIONS.sprint)).top8).toEqual(swapped.map(p.driverId));
  });
});

test.describe("race", function () {
  test("the status asks for each part in turn", async function ({ page, context }) {
    await member(context, "rstatus");
    await p.openSession(page, p.SESSIONS.race);
    await expect(page.locator("#pick-status")).toHaveText("0 of 8 selected");
    await p.tap(p.step(page, "Top 8"), TOP8);
    await expect(page.locator("#pick-status")).toHaveText("Choose the fastest lap driver");
    await p.tap(p.step(page, "Fastest lap"), ["nor"]);
    await expect(page.locator("#pick-status")).toHaveText("Answer the DNF question");
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(page.locator("#pick-status")).toHaveText("Pick 1 more DNF driver");
  });

  test("an unfinished race prediction is refused with the matching message", async function ({ page, context }) {
    await member(context, "rrefuse");
    await p.openSession(page, p.SESSIONS.race);
    await p.save(page);
    await p.expectError(page, "Please choose a driver for every top-8 position.");
    await p.tap(p.step(page, "Top 8"), TOP8);
    await p.save(page);
    await p.expectError(page, "Please choose the fastest lap driver.");
    await p.tap(p.step(page, "Fastest lap"), ["nor"]);
    await p.save(page);
    await p.expectError(page, "Please answer the DNF question.");
  });

  test("a race prediction with no retirements saves", async function ({ page, context }) {
    const user = await member(context, "rnodnf");
    await p.openSession(page, p.SESSIONS.race);
    await p.tap(p.step(page, "Top 8"), TOP8);
    await p.tap(p.step(page, "Fastest lap"), ["nor"]);
    await page.getByRole("button", { name: "No", exact: true }).click();
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");
    await p.save(page);
    await p.expectSaved(page);

    const picks = await p.savedPicks(api, user, p.SESSIONS.race);
    expect(picks.top8).toEqual(TOP8.map(p.driverId));
    expect(picks.fastest_lap).toBe(p.driverId("nor"));
    expect(picks.any_dnf).toBe(false);
    expect(picks.dnf_count).toBe(0);
    expect(picks.dnf_drivers).toEqual([]);
  });

  test("a race prediction with two retirements saves with both drivers", async function ({ page, context }) {
    const user = await member(context, "rdnf2");
    await p.openSession(page, p.SESSIONS.race);
    await p.tap(p.step(page, "Top 8"), TOP8);
    await p.tap(p.step(page, "Fastest lap"), ["pia"]);
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await page.getByRole("button", { name: "One more DNF" }).click();
    await expect(page.locator("output.stepper-value")).toHaveText("2");
    await p.tap(p.step(page, "Retirements"), ["str", "oco"]);
    await expect(page.locator("#pick-status")).toHaveText("Ready to save");
    await p.save(page);
    await p.expectSaved(page);

    const picks = await p.savedPicks(api, user, p.SESSIONS.race);
    expect(picks.any_dnf).toBe(true);
    expect(picks.dnf_count).toBe(2);
    expect(picks.dnf_drivers.slice().sort()).toEqual(["str", "oco"].map(p.driverId).sort());
    expect(picks.fastest_lap).toBe(p.driverId("pia"));
  });

  test("a driver cannot be in the top 8 and also be a DNF pick", async function ({ page, context }) {
    await member(context, "rblock");
    await p.openSession(page, p.SESSIONS.race);
    await p.tap(p.step(page, "Top 8"), TOP8);
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    // a top-8 driver cannot be chosen as a DNF
    await expect(p.driver(p.step(page, "Retirements"), "nor")).toBeDisabled();
    // and a DNF pick takes that driver out of the choices for the top 8
    await p.tap(p.step(page, "Retirements"), ["str"]);
    await expect(p.driver(p.step(page, "Top 8"), "str")).toBeDisabled();
  });

  test("a saved race prediction comes back complete after a reload", async function ({ page, context }) {
    const user = await member(context, "rreload");
    await p.openSession(page, p.SESSIONS.race);
    await p.tap(p.step(page, "Top 8"), TOP8);
    await p.tap(p.step(page, "Fastest lap"), ["ver"]);
    await page.getByRole("button", { name: "No", exact: true }).click();
    await p.save(page);
    await p.expectSaved(page);

    await p.openSession(page, p.SESSIONS.race);
    await expect(page.locator("#pick-status")).toHaveText("Prediction saved");
    expect(await p.slotOrder(p.step(page, "Top 8"))).toEqual(TOP8);
    await expect(p.driver(p.step(page, "Fastest lap"), "ver")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "No", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await p.savedPicks(api, user, p.SESSIONS.race)).not.toBeNull();
  });
});
