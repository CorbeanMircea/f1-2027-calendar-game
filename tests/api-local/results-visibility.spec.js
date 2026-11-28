// Lights Out: who can see results, and how the admin's pending count and the leaderboard follow them (T8, API tests, no browser).
// Rule under test (policy on results): group members can read APPROVED results only. A pending, rejected or superseded result is
// invisible to everyone through the table, the admin included; the admin works with it through the admin_* functions.
// The weekend is a private test event created for this file.
const { test, expect } = require("@playwright/test");
const { Api } = require("../fixtures/api");
const t = require("../fixtures/test-event");

test.describe.configure({ mode: "default" });

let api;
let event;
let race;
let sprint;
let player;
let watcher;
let admin;

async function pendingCount() {
  const res = await api.rpc("admin_pending_count", {}, admin.token);
  expect(res.status).toBe(200);
  return res.body;
}

async function resultsOf(session, user) {
  const res = await api.get("results", "select=id,status,version&session_id=eq." + session + "&order=version", user.token);
  expect(res.status).toBe(200);
  return res.body;
}

async function approve(id) {
  const res = await api.rpc("admin_approve_result", { p_result_id: id }, admin.token);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

test.beforeAll(async function () {
  api = await Api.create();
  event = t.createTestEvent("resvis", { race: "now() + interval '1 day'", sprint: "now() + interval '1 day'" });
  race = event.sessions.race;
  sprint = event.sessions.sprint;
  player = await api.createMember("player");
  watcher = await api.createMember("watcher");
  admin = await api.createMember("admin");
  api.makeAdmin(admin.id);
  expect((await api.rpc("submit_prediction", { p_session_id: race, p_picks: t.RACE_PICKS }, player.token)).status).toBeLessThan(300);
  expect((await api.rpc("submit_prediction", { p_session_id: sprint, p_picks: { top8: t.TOP8 } }, player.token)).status).toBeLessThan(300);
  t.setStart(race, "now() - interval '1 minute'");
  t.setStart(sprint, "now() - interval '1 minute'");
});

test.afterAll(async function () {
  t.deleteTestEvent(event);
  await api.dispose();
});

test.describe.serial("the life of a result", function () {
  let first;
  let before;

  test("a pending result is invisible to members and to the admin's table view, but counts as pending work", async function () {
    before = await pendingCount();
    first = t.enterResult(race, t.RACE_RESULT);
    expect(await resultsOf(race, watcher), "members must not see a pending result").toEqual([]);
    expect(await resultsOf(race, admin), "not even the admin sees it through the table").toEqual([]);
    expect(await pendingCount()).toBe(before + 1);
    const none = await api.get("scores", "select=user_id&session_id=eq." + race, watcher.token);
    expect(none.body, "and it has scored nothing").toEqual([]);
  });

  test("approving makes it visible to every member, scores the player, and clears the pending count", async function () {
    await approve(first);
    const seen = await resultsOf(race, watcher);
    expect(seen.length).toBe(1);
    expect(seen[0].status).toBe("approved");
    expect(await pendingCount()).toBe(before);

    const score = await api.get("scores", "select=points&session_id=eq." + race + "&user_id=eq." + player.id, watcher.token);
    expect(score.body[0].points, "the group can see a group-mate's score").toBe(65);
  });

  test("the leaderboard follows the approved score", async function () {
    const res = await api.get("leaderboard", "select=session_points,sessions_scored&user_id=eq." + player.id + "&season=eq.2026", watcher.token);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].session_points).toBe(65);
    expect(res.body[0].sessions_scored).toBe(1);
  });

  test("an edit is pending work and stays invisible until approved, and the old result stays in force meanwhile", async function () {
    const edited = await api.rpc("admin_save_result_edit", { p_result_id: first, p_data: Object.assign({}, t.RACE_RESULT, { fastest_lap: t.D("pia") }) }, admin.token);
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300);
    expect(await pendingCount()).toBe(before + 1);
    const seen = await resultsOf(race, watcher);
    expect(seen.map(function (r) { return r.version; }), "members still see only version 1").toEqual([1]);
    const score = await api.get("scores", "select=points&session_id=eq." + race + "&user_id=eq." + player.id, watcher.token);
    expect(score.body[0].points).toBe(65);

    await approve(edited.body);
    const after = await resultsOf(race, watcher);
    expect(after.map(function (r) { return r.version; }), "after approval only the new version is visible").toEqual([2]);
    const rescored = await api.get("scores", "select=points&session_id=eq." + race + "&user_id=eq." + player.id, watcher.token);
    expect(rescored.body[0].points, "the player lost the 3 fastest-lap points").toBe(62);
    const board = await api.get("leaderboard", "select=session_points&user_id=eq." + player.id + "&season=eq.2026", watcher.token);
    expect(board.body[0].session_points).toBe(62);
  });

  test("a rejected result never becomes visible and clears the pending count", async function () {
    const count = await pendingCount();
    const second = t.enterResult(sprint, { top8: t.TOP8 });
    expect(await pendingCount()).toBe(count + 1);
    const rejected = await api.rpc("admin_reject_result", { p_result_id: second }, admin.token);
    expect(rejected.status).toBeLessThan(300);
    expect(await pendingCount()).toBe(count);
    expect(await resultsOf(sprint, watcher)).toEqual([]);
    const none = await api.get("scores", "select=user_id&session_id=eq." + sprint, watcher.token);
    expect(none.body).toEqual([]);
  });

  test("players who are not admins cannot approve, reject or edit results", async function () {
    const stray = t.enterResult(sprint, { top8: t.TOP8 });
    for (const [fn, args] of [["admin_approve_result", { p_result_id: stray }], ["admin_reject_result", { p_result_id: stray }],
                               ["admin_save_result_edit", { p_result_id: stray, p_data: { top8: t.TOP8 } }]]) {
      const res = await api.rpc(fn, args, player.token);
      expect(res.status, fn).toBeGreaterThanOrEqual(400);
      expect(res.body.message, fn).toBe("Admins only");
    }
    expect(await resultsOf(sprint, watcher)).toEqual([]);
  });
});
