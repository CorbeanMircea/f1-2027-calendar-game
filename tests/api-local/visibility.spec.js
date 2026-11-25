// Lights Out: who can see a prediction, and when (API tests against the LOCAL Supabase stack, no browser).
// Rule under test (policy on predictions): you always see your own; group-mates' predictions appear only once the session has
// STARTED. Nobody, not even an admin, sees them earlier. A session with no start time stays hidden and closed.
// The session used is the practice event's qualifying session; its start time is set here and put back afterwards.
const { test, expect } = require("@playwright/test");
const { Api, isPermissionDenied } = require("../fixtures/api");
const db = require("../fixtures/local-db");

test.describe.configure({ mode: "default" });

const SESSION = "practice-event-qualifying";
const PICKS = {
  q1_out: ["practice-q", "practice-r", "practice-s", "practice-t", "practice-u", "practice-v"],
  q2_out: ["practice-k", "practice-l", "practice-m", "practice-n", "practice-o", "practice-p"],
  q3_order: ["practice-a", "practice-b", "practice-c", "practice-d", "practice-e", "practice-f", "practice-g", "practice-h", "practice-i", "practice-j"]
};

let api;
let alice;
let bob;
let admin;
let stranger;
let originalStart; // text of the real start time, or "" when it had none

function setStart(expression) {
  db.psql("update public.sessions set start_utc = " + expression + " where id = " + db.literal(SESSION));
}

function visibleToOthers(user) {
  return api.get("predictions", "select=user_id,picks&session_id=eq." + SESSION + "&user_id=eq." + alice.id, user ? user.token : undefined);
}

test.beforeAll(async function () {
  api = await Api.create();
  originalStart = db.psql("select coalesce(start_utc::text, '') from public.sessions where id = " + db.literal(SESSION));
  alice = await api.createMember("alice");
  bob = await api.createMember("bob");
  admin = await api.createMember("admin");
  api.makeAdmin(admin.id);
  stranger = await api.signUp("stranger");

  setStart("now() + interval '2 days'");
  const saved = await api.rpc("submit_prediction", { p_session_id: SESSION, p_picks: PICKS }, alice.token);
  expect(saved.status, "the first prediction must save while the session is open: " + JSON.stringify(saved.body)).toBeLessThan(300);
});

test.afterAll(async function () {
  setStart(originalStart === "" ? "null" : db.literal(originalStart) + "::timestamptz");
  await api.dispose();
});

test.describe("before the session starts", function () {
  test.beforeEach(function () { setStart("now() + interval '2 days'"); });

  test("the player sees their own prediction", async function () {
    const res = await visibleToOthers(alice);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].picks.q3_order[0]).toBe("practice-a");
  });

  test("group-mates cannot see it, and neither can an admin", async function () {
    for (const viewer of [bob, admin]) {
      const res = await visibleToOthers(viewer);
      expect(res.status).toBe(200);
      expect(res.body, "a prediction must stay hidden until the session starts").toEqual([]);
    }
  });

  test("a stranger and an anonymous visitor cannot see it either", async function () {
    expect((await visibleToOthers(stranger)).body).toEqual([]);
    expect(isPermissionDenied(await visibleToOthers(undefined))).toBe(true);
  });

  test("it can still be changed, and the change replaces the saved picks", async function () {
    const swapped = JSON.parse(JSON.stringify(PICKS));
    swapped.q3_order[0] = "practice-b";
    swapped.q3_order[1] = "practice-a";
    const res = await api.rpc("submit_prediction", { p_session_id: SESSION, p_picks: swapped }, alice.token);
    expect(res.status).toBeLessThan(300);
    const mine = await visibleToOthers(alice);
    expect(mine.body.length).toBe(1);
    expect(mine.body[0].picks.q3_order[0]).toBe("practice-b");

    await api.rpc("submit_prediction", { p_session_id: SESSION, p_picks: PICKS }, alice.token); // put the original back
  });

  test("another member's own prediction is separate and stays private too", async function () {
    const res = await api.rpc("submit_prediction", { p_session_id: SESSION, p_picks: PICKS }, bob.token);
    expect(res.status).toBeLessThan(300);
    const alicesView = await api.get("predictions", "select=user_id&session_id=eq." + SESSION + "&user_id=eq." + bob.id, alice.token);
    expect(alicesView.body).toEqual([]);
  });
});

test.describe("once the session has started", function () {
  test.beforeEach(function () { setStart("now() - interval '1 hour'"); });

  test("group-mates and the admin can now see the prediction", async function () {
    for (const viewer of [bob, admin]) {
      const res = await visibleToOthers(viewer);
      expect(res.status).toBe(200);
      expect(res.body.length, "the prediction must be visible after the start").toBe(1);
      expect(res.body[0].user_id).toBe(alice.id);
    }
  });

  test("a stranger outside the group still cannot see it", async function () {
    expect((await visibleToOthers(stranger)).body).toEqual([]);
  });

  test("nobody can save or change a prediction any more", async function () {
    const res = await api.rpc("submit_prediction", { p_session_id: SESSION, p_picks: PICKS }, alice.token);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toBe("Predictions are closed for this session");
  });

  test("the session reports itself as locked", async function () {
    const res = await api.rpc("is_prediction_locked", { p_session_id: SESSION }, bob.token);
    expect(res.status).toBe(200);
    expect(res.body).toBe(true);
  });
});

test.describe("when the start time is unknown", function () {
  test.beforeEach(function () { setStart("null"); });

  test("predictions are closed and stay hidden", async function () {
    const closed = await api.rpc("submit_prediction", { p_session_id: SESSION, p_picks: PICKS }, bob.token);
    expect(closed.status).toBeGreaterThanOrEqual(400);
    expect(closed.body.message).toBe("Predictions are closed for this session");

    const hidden = await visibleToOthers(bob);
    expect(hidden.body, "an unknown start time must not reveal anything").toEqual([]);
    const locked = await api.rpc("is_prediction_locked", { p_session_id: SESSION }, bob.token);
    expect(locked.body).toBe(false);
  });
});
