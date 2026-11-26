// Lights Out: the local Supabase API as a test sees it, without a browser (sign up, call tables and functions as a given user).
// Only ever talks to the LOCAL stack (tests/fixtures/local-env.js refuses anything else).
const crypto = require("crypto");
const { request, expect } = require("@playwright/test");
const { LOCAL_URL, LOCAL_KEY, LOCAL_INVITE_CODE, assertLocalUrl, assertNotProductionKey } = require("./local-env");
const db = require("./local-db");
const model = require("./permission-model");

class Api {
  constructor(context) {
    this.context = context;
  }

  static async create() {
    assertLocalUrl(LOCAL_URL);
    assertNotProductionKey(LOCAL_KEY);
    const context = await request.newContext({ baseURL: LOCAL_URL, extraHTTPHeaders: { apikey: LOCAL_KEY } });
    return new Api(context);
  }

  async dispose() {
    await this.context.dispose();
  }

  // One request. token = a signed-in user's access token; leave it out to act as an anonymous visitor.
  async send(method, url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.token) { headers.Authorization = "Bearer " + opts.token; }
    const res = await this.context.fetch(url, { method: method, headers: headers, data: opts.body });
    const text = await res.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch (e) { /* keep the text */ }
    return { status: res.status(), body: body };
  }

  get(table, query, token) {
    return this.send("GET", "/rest/v1/" + table + (query ? "?" + query : ""), { token: token });
  }
  post(table, body, token) {
    return this.send("POST", "/rest/v1/" + table, { token: token, body: body });
  }
  patch(table, query, body, token) {
    return this.send("PATCH", "/rest/v1/" + table + "?" + query, { token: token, body: body });
  }
  del(table, query, token) {
    return this.send("DELETE", "/rest/v1/" + table + "?" + query, { token: token });
  }
  rpc(name, args, token) {
    return this.send("POST", "/rest/v1/rpc/" + name, { token: token, body: args || {} });
  }

  // Tries to insert into, update and delete from a table. Returns the three results, so a test can check that all were refused.
  async tryWrites(table, token) {
    const column = model.PLAIN_COLUMN[table];
    const body = {};
    body[column] = null;
    return [
      await this.post(table, {}, token),
      await this.patch(table, column + "=is.null", body, token),
      await this.del(table, column + "=is.null", token)
    ];
  }

  // Creates a brand-new made-up player and signs them in.
  async signUp(label) {
    const id = crypto.randomBytes(4).toString("hex");
    const user = { email: "api-" + (label || "player") + "-" + id + "@lightsout.test", password: "Test-Pass-1234", shortId: id };
    const res = await this.send("POST", "/auth/v1/signup", { body: { email: user.email, password: user.password } });
    expect(res.status, "sign-up must succeed: " + JSON.stringify(res.body)).toBe(200);
    expect(res.body.access_token, "sign-up must return a session (is e-mail confirmation off locally?)").toBeTruthy();
    user.id = res.body.user.id;
    user.token = res.body.access_token;
    user.session = res.body; // the whole session, so a browser can be signed in without typing anything
    return user;
  }

  // A new player who has also joined the seeded group with the seed invite code.
  async createMember(label) {
    const user = await this.signUp(label);
    user.displayName = "API " + user.shortId;
    const res = await this.rpc("join_group", { p_invite_code: LOCAL_INVITE_CODE, p_display_name: user.displayName }, user.token);
    expect(res.status, "joining the group must succeed: " + JSON.stringify(res.body)).toBeLessThan(300);
    return user;
  }

  // Promotes a player to admin directly in the local database (there is deliberately no API for this).
  makeAdmin(userId) {
    db.psql("update public.group_members set role = 'admin' where user_id = " + db.literal(userId) + "::uuid");
  }
}

// PostgREST answers a permission refusal with 401 (anonymous) or 403 (signed in) and the database error code 42501.
function isPermissionDenied(res) {
  return (res.status === 401 || res.status === 403) && !!res.body && res.body.code === "42501";
}

module.exports = { Api, isPermissionDenied };
