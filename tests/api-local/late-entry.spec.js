// Lights Out: late entries and when predictions are revealed (T7, API tests against the LOCAL Supabase stack, no browser).
// Rules under test (migration 039, "P13"):
//   * a Race (or Sprint) prediction is open until THAT session starts;
//   * but if it is first saved, or really changed, after the Qualifying (Sprint Qualifying) session has started, it is a LATE
//     ENTRY and scores 70% of its points, rounded down;
//   * saving the same picks again changes nothing, so it never turns an entry late;
//   * a Qualifying prediction is never late; an unknown Qualifying time never makes anyone late;
//   * a prediction becomes visible to the group when its own session starts.
// The weekend is a private test event created for this file, with the picks and the result chosen so a full-value score is the maximum.
const { test, expect } = require("@playwright/test");
const { Api } = require("../fixtures/api");
const t = require("../fixtures/test-event");

test.describe.configure({ mode: "default" }); // the phases below run in order, in one worker

let api;
let event;
let q;      // qualifying session id
let r;      // race session id
let early;  // saves before Qualifying and never touches it again
let edited; // saves an imperfect race prediction before Qualifying, then corrects it after Qualifying has started
let same;   // saves before Qualifying, then saves the identical picks again after it has started
let late;   // saves for the first time after Qualifying has started
let watcher;
let admin;

const SWAPPED = Object.assign({}, t.RACE_PICKS, { top8: [t.TOP8[1], t.TOP8[0]].concat(t.TOP8.slice(2)) });

async function submit(user, session, picks) {
  const res = await api.rpc("submit_prediction", { p_session_id: session, p_picks: picks }, user.token);
  expect(res.status, "saving must work: " + JSON.stringify(res.body)).toBeLessThan(300);
}

async function mine(user, session) {
  const res = await api.get("predictions", "select=created_at,updated_at,picks&session_id=eq." + session + "&user_id=eq." + user.id, user.token);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  return { created: Date.parse(res.body[0].created_at), updated: Date.parse(res.body[0].updated_at), picks: res.body[0].picks };
}

async function windowOf(session) {
  const res = await api.get("prediction_windows", "select=is_open,is_late,lock_at,full_value_until&session_id=eq." + session);
  expect(res.status).toBe(200);
  return res.body[0];
}

test.beforeAll(async function () {
  api = await Api.create();
  event = t.createTestEvent("late", { qualifying: "now() + interval '3 hours'", race: "now() + interval '1 day'" });
  q = event.sessions.qualifying;
  r = event.sessions.race;
  early = await api.createMember("early");
  edited = await api.createMember("edited");
  same = await api.createMember("same");
  late = await api.createMember("late");
  watcher = await api.createMember("watcher");
  admin = await api.createMember("admin");
  api.makeAdmin(admin.id);
});

test.afterAll(async function () {
  t.deleteTestEvent(event);
  await api.dispose();
});

test.describe.serial("a race weekend, in order", function () {
  test("1. before Qualifying: everyone saves at full value", async function () {
    await submit(early, q, t.QUALI_PICKS);
    await submit(early, r, t.RACE_PICKS);
    await submit(edited, r, SWAPPED);
    await submit(same, r, t.RACE_PICKS);

    const race = await windowOf(r);
    expect(race.is_open).toBe(true);
    expect(race.is_late, "no one is late before Qualifying starts").toBe(false);
    t.backdate([q, r], "2 hours"); // time passes: these saves now date from two hours ago
    expect(race.full_value_until, "the full-value deadline is the Qualifying start").toBe((await windowOf(q)).lock_at);
  });

  test("2. Qualifying starts: the Race stays open but becomes a late entry window", async function () {
    t.setStart(q, "now() - interval '1 hour'"); // one hour ago: after the (back-dated) early saves
    const race = await windowOf(r);
    expect(race.is_open, "the Race is open until the Race starts").toBe(true);
    expect(race.is_late).toBe(true);
    expect((await windowOf(q)).is_open, "Qualifying itself is now locked").toBe(false);

    const refused = await api.rpc("submit_prediction", { p_session_id: q, p_picks: t.QUALI_PICKS }, late.token);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toBe("Predictions are closed for this session");
  });

  test("3. what the group can see now: Qualifying picks yes, Race picks not yet", async function () {
    const qual = await api.get("predictions", "select=user_id&session_id=eq." + q + "&user_id=eq." + early.id, watcher.token);
    expect(qual.body.length, "a Qualifying prediction is revealed when Qualifying starts").toBe(1);
    const race = await api.get("predictions", "select=user_id&session_id=eq." + r + "&user_id=eq." + early.id, watcher.token);
    expect(race.body, "a Race prediction stays private until the Race starts").toEqual([]);
  });

  test("4. after Qualifying: a real change and a first save are late, an identical save is not", async function () {
    await submit(edited, r, t.RACE_PICKS);   // a real change
    await submit(same, r, t.RACE_PICKS);     // the identical picks again
    await submit(late, r, t.RACE_PICKS);     // first save

    const start = Date.parse(t.startOf(q));
    const a = await mine(early, r);
    const b = await mine(edited, r);
    const c = await mine(same, r);
    const d = await mine(late, r);

    expect(a.updated, "untouched: still dated before Qualifying").toBeLessThan(start);
    expect(c.updated, "an identical save must not move updated_at").toBeLessThan(start);
    expect(c.updated).toBe(c.created);
    expect(b.updated, "a real change moves updated_at to after Qualifying").toBeGreaterThanOrEqual(start);
    expect(b.created, "the original save time is kept").toBeLessThan(start);
    expect(d.created, "a first save after Qualifying").toBeGreaterThanOrEqual(start);
  });

  test("5. the Race starts: its predictions are revealed and saving is closed", async function () {
    t.setStart(r, "now() - interval '1 second'");
    const all = await api.get("predictions", "select=user_id&session_id=eq." + r, watcher.token);
    expect(all.body.length, "all four Race predictions are visible to the group").toBe(4);

    const refused = await api.rpc("submit_prediction", { p_session_id: r, p_picks: t.RACE_PICKS }, early.token);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toBe("Predictions are closed for this session");
  });

  test("6. scoring: full value for the on-time entries, 70% (rounded down) for the late ones", async function () {
    const resultId = t.enterResult(r, t.RACE_RESULT);
    const approve = await api.rpc("admin_approve_result", { p_result_id: resultId }, admin.token);
    expect(approve.status, JSON.stringify(approve.body)).toBeLessThan(300);

    const res = await api.get("scores", "select=user_id,points,breakdown&session_id=eq." + r, watcher.token);
    expect(res.status).toBe(200);
    const byUser = {};
    res.body.forEach(function (row) { byUser[row.user_id] = row; });

    expect(byUser[early.id].points, "on time, never touched").toBe(65);
    expect(byUser[same.id].points, "on time, identical re-save").toBe(65);
    expect(byUser[early.id].breakdown.late).toBeFalsy();
    expect(byUser[same.id].breakdown.late).toBeFalsy();

    // floor(65 * 0.7) = floor(45.5) = 45
    for (const user of [edited, late]) {
      const row = byUser[user.id];
      expect(row.points, "late entry").toBe(45);
      expect(row.breakdown.late).toBe(true);
      expect(row.breakdown.raw_total).toBe(65);
      expect(row.breakdown.late_factor).toBe(0.7);
    }
  });

  test("7. a Qualifying prediction is never late", async function () {
    const resultId = t.enterResult(q, t.QUALI_RESULT);
    const approve = await api.rpc("admin_approve_result", { p_result_id: resultId }, admin.token);
    expect(approve.status).toBeLessThan(300);
    const res = await api.get("scores", "select=points,breakdown&session_id=eq." + q + "&user_id=eq." + early.id, watcher.token);
    expect(res.body.length).toBe(1);
    expect(res.body[0].points).toBe(62);
    expect(res.body[0].breakdown.late).toBeFalsy();
  });
});

test.describe("the late-entry rule itself, at the boundaries", function () {
  test("the late factor is 0.7", function () {
    expect(Number(t.lateFactor())).toBe(0.7);
  });

  test("an entry exactly at the Qualifying start is late, one microsecond earlier is not", function () {
    const e = t.createTestEvent("bound", { qualifying: "'2030-06-01 12:00:00+00'", race: "'2030-06-02 12:00:00+00'" });
    try {
      expect(t.isLate(e.sessions.race, "timestamptz '2030-06-01 12:00:00+00'"), "exactly at the start").toBe(true);
      expect(t.isLate(e.sessions.race, "timestamptz '2030-06-01 11:59:59.999999+00'"), "one microsecond before").toBe(false);
      expect(t.isLate(e.sessions.race, "timestamptz '2030-06-01 12:00:00.000001+00'"), "one microsecond after").toBe(true);
      expect(t.isLate(e.sessions.race, "timestamptz '2030-06-02 11:00:00+00'"), "long after Qualifying, before the Race").toBe(true);
      expect(t.isLate(e.sessions.qualifying, "timestamptz '2031-01-01 00:00:00+00'"), "a Qualifying session is never late").toBe(false);
    } finally {
      t.deleteTestEvent(e);
    }
  });

  test("an unknown Qualifying time never makes an entry late", function () {
    const e = t.createTestEvent("unknown", { qualifying: "null", race: "now() + interval '1 day'" });
    try {
      expect(t.isLate(e.sessions.race, "now() + interval '10 years'")).toBe(false);
    } finally {
      t.deleteTestEvent(e);
    }
  });
});

test.describe("a Race with no confirmed Qualifying time", function () {
  test("is open, never late, and scores in full", async function () {
    const e = t.createTestEvent("tbc", { qualifying: "null", race: "now() + interval '1 day'" });
    const player = await api.createMember("tbc");
    try {
      const w = (await api.get("prediction_windows", "select=is_open,is_late,full_value_until&session_id=eq." + e.sessions.race)).body[0];
      expect(w.is_open).toBe(true);
      expect(w.is_late).toBe(false);
      expect(w.full_value_until).toBeNull();

      const saved = await api.rpc("submit_prediction", { p_session_id: e.sessions.race, p_picks: t.RACE_PICKS }, player.token);
      expect(saved.status).toBeLessThan(300);

      t.setStart(e.sessions.race, "now() - interval '1 second'");
      const resultId = t.enterResult(e.sessions.race, t.RACE_RESULT);
      expect((await api.rpc("admin_approve_result", { p_result_id: resultId }, admin.token)).status).toBeLessThan(300);
      const score = await api.get("scores", "select=points,breakdown&session_id=eq." + e.sessions.race + "&user_id=eq." + player.id, player.token);
      expect(score.body[0].points).toBe(65);
      expect(score.body[0].breakdown.late).toBeFalsy();
    } finally {
      t.deleteTestEvent(e);
    }
  });
});
