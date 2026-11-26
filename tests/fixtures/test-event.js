// Lights Out: throw-away race weekends for tests (T7).
// A test creates its own event in the LOCAL database, with the sessions and start times it needs, and deletes it afterwards.
// Deleting the event removes its sessions, predictions, results and scores too (they are linked with ON DELETE CASCADE), so a
// test never touches the seeded weekends and two tests never share a session. Uses the seeded 2026 drivers.
const crypto = require("crypto");
const db = require("./local-db");

const ALL_TYPES = ["sprint_qualifying", "sprint", "qualifying", "race"];

// times: { qualifying: "now() + interval '3 hours'", race: "now() + interval '1 day'", ... }  (SQL expressions; "null" = unknown)
function createTestEvent(label, times) {
  const suffix = crypto.randomBytes(3).toString("hex");
  const id = "e2e-" + label + "-" + suffix;
  const name = "E2E " + label + " " + suffix + " Grand Prix";
  let created = false;
  for (let attempt = 0; attempt < 6 && !created; attempt++) {
    const round = 5000 + Math.floor(Math.random() * 4000); // (season, round) must be unique
    try {
      db.psql(
        "insert into public.events (id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status) values (" +
        [db.literal(id), "2026", String(round), db.literal(name), "'Test Circuit'", "'Testville'", "'Testland'", "current_date", "current_date + 2", "false", "'scheduled'"].join(", ") + ")"
      );
      created = true;
    } catch (e) {
      if (attempt === 5) { throw e; }
    }
  }
  const sessions = {};
  Object.keys(times).forEach(function (type) {
    if (ALL_TYPES.indexOf(type) === -1) { throw new Error("unknown session type " + type); }
    sessions[type] = id + "-" + type;
    db.psql("insert into public.sessions (id, event_id, session_type, start_utc) values (" +
      [db.literal(sessions[type]), db.literal(id), db.literal(type), times[type]].join(", ") + ")");
  });
  return { id: id, name: name, sessions: sessions };
}

// Moves a session's start time. expression is SQL: "now() - interval '1 minute'", or "null" for unknown.
function setStart(sessionId, expression) {
  db.psql("update public.sessions set start_utc = " + expression + " where id = " + db.literal(sessionId));
}

// Pretends the saves in these sessions happened earlier (the clock cannot be wound back, so the data is moved instead).
function backdate(sessionIds, interval) {
  const list = sessionIds.map(function (id) { return db.literal(id); }).join(", ");
  db.psql("update public.predictions set created_at = created_at - interval " + db.literal(interval) +
    ", updated_at = updated_at - interval " + db.literal(interval) + " where session_id in (" + list + ")");
}

function startOf(sessionId) {
  return db.psql("select start_utc::text from public.sessions where id = " + db.literal(sessionId));
}

function deleteTestEvent(event) {
  db.psql("delete from public.events where id = " + db.literal(event.id));
}

// Enters a result directly in the database (the importer's job in real life) and returns its id, ready for an admin to approve.
function enterResult(sessionId, data) {
  return db.psql("select public.enter_result(" + db.literal(sessionId) + ", " + db.literal(JSON.stringify(data)) + "::jsonb, 'e2e')");
}

// A question to the database's internal late-entry rules (not reachable through the API on purpose).
function isLate(sessionId, timestampExpression) {
  return db.psql("select public.lo_is_late(" + db.literal(sessionId) + ", " + timestampExpression + ")") === "t";
}

function lateFactor() {
  return db.psql("select public.lo_late_factor()");
}

// The seeded 2026 drivers, as ids.
const D = function (code) { return "2026-" + code; };

// Result and picks that match each other perfectly (so a full-value score is the published maximum).
const TOP8 = ["nor", "pia", "ver", "ham", "lec", "rus", "ant", "alo"].map(D);
const RACE_PICKS = { top8: TOP8, fastest_lap: D("nor"), any_dnf: false, dnf_count: 0, dnf_drivers: [] };
const RACE_RESULT = { top8: TOP8, fastest_lap: D("nor"), dnf_drivers: [], grid_top8: TOP8 };
const QUALI_PICKS = {
  q1_out: ["per", "pia", "rus", "sai", "str", "ver"].map(D),
  q2_out: ["hul", "law", "lec", "lin", "nor", "oco"].map(D),
  q3_order: ["alb", "alo", "ant", "bea", "bor", "bot", "col", "gas", "had", "ham"].map(D)
};
const QUALI_RESULT = { q1_out: QUALI_PICKS.q1_out, q2_out: QUALI_PICKS.q2_out, q3_order: QUALI_PICKS.q3_order };

module.exports = {
  createTestEvent, setStart, backdate, startOf, deleteTestEvent, enterResult, isLate, lateFactor,
  D, TOP8, RACE_PICKS, RACE_RESULT, QUALI_PICKS, QUALI_RESULT
};
