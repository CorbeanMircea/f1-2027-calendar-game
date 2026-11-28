// Lights Out: direct access to the LOCAL test database, for setting up and checking state that the public API cannot reach
// (promoting a test player to admin, moving a session start time, reading the permission catalog).
// It goes through "docker exec" into the local test container only. It never uses a network address, key or password.
const { execFileSync } = require("child_process");

const CONTAINER = process.env.LO_LOCAL_DB_CONTAINER || "supabase_db_lights-out-test";

if (CONTAINER.indexOf("lights-out-test") === -1) {
  throw new Error("SAFETY: refusing to use a database container that is not the Lights Out local test container: " + CONTAINER);
}

// Runs one SQL statement as the local database owner and returns the text of the result.
function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

// Runs a larger script that is sent through standard input (no command-line length limit).
function psqlStdin(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"],
    { encoding: "utf8", input: sql, maxBuffer: 256 * 1024 * 1024 }
  ).trim();
}

// For queries that return one JSON value (for example select json_agg(...)).
function psqlJson(sql) {
  return JSON.parse(psql(sql));
}

// A safely quoted SQL text literal.
function literal(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

module.exports = { CONTAINER, psql, psqlStdin, psqlJson, literal };
