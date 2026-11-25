// Lights Out: who may read, write and call what (API tests against the LOCAL Supabase stack, no browser).
// Every table and every function is tried as an anonymous visitor, a signed-in stranger, a group member and an admin.
// A refusal must be a real PERMISSION refusal (HTTP 401/403 with database code 42501), not "no such function".
const { test, expect } = require("@playwright/test");
const { Api, isPermissionDenied } = require("../fixtures/api");
const model = require("../fixtures/permission-model");

test.describe.configure({ mode: "default" }); // one worker per file: the players created below are shared by the tests

const PUBLIC_OBJECTS = model.ANON_READABLE.concat(["season_prediction_windows"]);
const PROTECTED_FOR_ANON = Array.from(new Set(model.SIGNED_IN_READABLE.concat(model.NO_CLIENT_ACCESS)))
  .filter(function (name) { return model.ANON_READABLE.indexOf(name) === -1; });
const GROUP_DATA = model.SIGNED_IN_READABLE.concat(model.NO_CLIENT_ACCESS)
  .filter(function (name) { return PUBLIC_OBJECTS.indexOf(name) === -1 && model.NO_CLIENT_ACCESS.indexOf(name) === -1; });
const ALL_CLIENT_FUNCTIONS = model.ADMIN_FUNCTIONS.concat(model.PLAYER_FUNCTIONS);

let api;
let stranger;
let member;
let admin;

test.beforeAll(async function () {
  api = await Api.create();
  stranger = await api.signUp("stranger");
  member = await api.createMember("member");
  admin = await api.createMember("admin");
  api.makeAdmin(admin.id);
});

test.afterAll(async function () {
  await api.dispose();
});

test.describe("anonymous visitors (nobody signed in)", function () {
  test("can read the public schedule data and nothing else", async function () {
    for (const name of model.ANON_READABLE) {
      const res = await api.get(name, "select=*&limit=1");
      expect(res.status, name).toBe(200);
      expect(Array.isArray(res.body), name).toBe(true);
    }
    const events = await api.get("events", "select=id&limit=1");
    expect(events.body.length, "the calendar must be public").toBe(1);

    const refused = [];
    for (const name of PROTECTED_FOR_ANON) {
      const res = await api.get(name, "select=*&limit=1");
      if (!isPermissionDenied(res)) { refused.push(name + " -> " + res.status); }
    }
    expect(refused, "these must all refuse anonymous visitors").toEqual([]);
  });

  test("cannot write to any table, not even the public ones", async function () {
    const wrong = [];
    for (const name of model.TABLES) {
      for (const res of await api.tryWrites(name)) {
        if (!isPermissionDenied(res)) { wrong.push(name + " -> " + res.status); }
      }
    }
    expect(wrong, "writes by anonymous visitors that were not refused").toEqual([]);
  });

  test("cannot call any function", async function () {
    const wrong = [];
    for (const fn of ALL_CLIENT_FUNCTIONS.concat(model.INTERNAL_FUNCTIONS)) {
      const res = await api.rpc(fn, model.DUMMY_ARGS[fn]);
      if (!isPermissionDenied(res)) { wrong.push(fn + " -> " + res.status); }
    }
    expect(wrong, "functions an anonymous visitor could reach").toEqual([]);
  });
});

test.describe("a signed-in stranger (has an account, has not joined the group)", function () {
  test("sees the public schedule but no group data at all", async function () {
    const leaks = [];
    for (const name of GROUP_DATA) {
      const res = await api.get(name, "select=*&limit=5", stranger.token);
      if (res.status !== 200 || !Array.isArray(res.body) || res.body.length !== 0) { leaks.push(name + " -> " + res.status + " rows=" + (res.body && res.body.length)); }
    }
    expect(leaks, "group data visible to someone outside the group").toEqual([]);

    const events = await api.get("events", "select=id&limit=1", stranger.token);
    expect(events.body.length).toBe(1);
  });

  test("cannot read the tables that have no client access", async function () {
    for (const name of model.NO_CLIENT_ACCESS) {
      const res = await api.get(name, "select=*&limit=1", stranger.token);
      expect(isPermissionDenied(res), name + " -> " + res.status).toBe(true);
    }
  });

  test("cannot write to any table", async function () {
    const wrong = [];
    for (const name of model.TABLES) {
      for (const res of await api.tryWrites(name, stranger.token)) {
        if (!isPermissionDenied(res)) { wrong.push(name + " -> " + res.status); }
      }
    }
    expect(wrong, "writes by a signed-in stranger that were not refused").toEqual([]);
  });

  test("cannot call the internal functions", async function () {
    const wrong = [];
    for (const fn of model.INTERNAL_FUNCTIONS) {
      const res = await api.rpc(fn, model.DUMMY_ARGS[fn], stranger.token);
      if (!isPermissionDenied(res)) { wrong.push(fn + " -> " + res.status); }
    }
    expect(wrong, "internal functions a signed-in user could reach").toEqual([]);
  });

  test("is not an admin and every admin function refuses them", async function () {
    const me = await api.rpc("is_admin", {}, stranger.token);
    expect(me.status).toBe(200);
    expect(me.body).toBe(false);
    const wrong = [];
    for (const fn of model.ADMIN_FUNCTIONS) {
      const res = await api.rpc(fn, model.DUMMY_ARGS[fn], stranger.token);
      const said = res.body && res.body.message;
      const expected = model.ADMIN_REFUSAL[fn] || "Admins only";
      if (res.status < 400 || said !== expected) { wrong.push(fn + " -> " + res.status + " " + said); }
    }
    expect(wrong, "admin functions that did not refuse a non-admin").toEqual([]);
  });

  test("cannot predict before joining the group, and a wrong invite code does not let them in", async function () {
    const predict = await api.rpc("submit_prediction", { p_session_id: "practice-event-qualifying", p_picks: {} }, stranger.token);
    expect(predict.status).toBeGreaterThanOrEqual(400);
    expect(predict.body.message).toBe("Join the friends group before predicting");

    const join = await api.rpc("join_group", { p_invite_code: "WRONG-CODE", p_display_name: "Stranger " + stranger.shortId }, stranger.token);
    expect(join.status).toBeGreaterThanOrEqual(400);
    expect(join.body.message).toBe("Invalid invite code");
    const still = await api.get("group_members", "select=user_id", stranger.token);
    expect(still.body).toEqual([]);
  });
});

test.describe("a group member who is not an admin", function () {
  test("sees the group's data: members, profiles, scores, results, locked predictions", async function () {
    const minimum = { group_members: 4, profiles: 4, scores: 10, results: 4, predictions: 10, leaderboard: 3, player_xp: 4 };
    for (const name of Object.keys(minimum)) {
      const res = await api.get(name, "select=*", member.token);
      expect(res.status, name).toBe(200);
      expect(res.body.length, name + " rows visible to a member").toBeGreaterThanOrEqual(minimum[name]);
    }
  });

  test("sees their own membership with the role 'member'", async function () {
    const res = await api.get("group_members", "select=role,groups(name)&user_id=eq." + member.id, member.token);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].role).toBe("member");
    expect(res.body[0].groups.name).toBe("Lights Out Test Group");
  });

  test("cannot make themselves an admin, directly or by any other table write", async function () {
    const promote = await api.patch("group_members", "user_id=eq." + member.id, { role: "admin" }, member.token);
    expect(isPermissionDenied(promote), "promoting yourself must be refused: " + promote.status).toBe(true);

    const wrong = [];
    for (const name of model.TABLES) {
      for (const res of await api.tryWrites(name, member.token)) {
        if (!isPermissionDenied(res)) { wrong.push(name + " -> " + res.status); }
      }
    }
    expect(wrong, "direct writes by a member that were not refused").toEqual([]);

    const me = await api.rpc("is_admin", {}, member.token);
    expect(me.body).toBe(false);
  });

  test("every admin function refuses them", async function () {
    const wrong = [];
    for (const fn of model.ADMIN_FUNCTIONS) {
      const res = await api.rpc(fn, model.DUMMY_ARGS[fn], member.token);
      const said = res.body && res.body.message;
      const expected = model.ADMIN_REFUSAL[fn] || "Admins only";
      if (res.status < 400 || said !== expected) { wrong.push(fn + " -> " + res.status + " " + said); }
    }
    expect(wrong, "admin functions that did not refuse a non-admin").toEqual([]);
  });

  test("cannot call the internal functions", async function () {
    const wrong = [];
    for (const fn of model.INTERNAL_FUNCTIONS) {
      const res = await api.rpc(fn, model.DUMMY_ARGS[fn], member.token);
      if (!isPermissionDenied(res)) { wrong.push(fn + " -> " + res.status); }
    }
    expect(wrong, "internal functions a member could reach").toEqual([]);
  });

  test("cannot see another player's private rows", async function () {
    for (const name of ["player_notifications", "push_subscriptions"]) {
      const res = await api.get(name, "select=*", member.token);
      expect(res.status, name).toBe(200);
      expect(res.body, name + " is private to its owner").toEqual([]);
    }
  });
});

test.describe("an admin", function () {
  test("is recognised, and the admin overview works", async function () {
    const me = await api.rpc("is_admin", {}, admin.token);
    expect(me.status).toBe(200);
    expect(me.body).toBe(true);
    const overview = await api.rpc("admin_overview", {}, admin.token);
    expect(overview.status).toBe(200);
    expect(overview.body).not.toBeNull();
    const pending = await api.rpc("admin_pending_count", {}, admin.token);
    expect(pending.status).toBe(200);
  });

  test("can read the admin-only history tables", async function () {
    for (const name of ["prediction_corrections", "season_prediction_log"]) {
      const res = await api.get(name, "select=*&limit=5", admin.token);
      expect(res.status, name).toBe(200);
      expect(Array.isArray(res.body), name).toBe(true);
    }
  });

  test("still cannot write any table directly: admin powers exist only as functions", async function () {
    const wrong = [];
    for (const name of model.TABLES) {
      for (const res of await api.tryWrites(name, admin.token)) {
        if (!isPermissionDenied(res)) { wrong.push(name + " -> " + res.status); }
      }
    }
    expect(wrong, "direct writes by an admin that were not refused").toEqual([]);
  });

  test("cannot call the internal functions either", async function () {
    const wrong = [];
    for (const fn of model.INTERNAL_FUNCTIONS) {
      const res = await api.rpc(fn, model.DUMMY_ARGS[fn], admin.token);
      if (!isPermissionDenied(res)) { wrong.push(fn + " -> " + res.status); }
    }
    expect(wrong, "internal functions an admin could reach").toEqual([]);
  });
});
