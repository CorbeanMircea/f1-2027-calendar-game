// Lights Out: the predictions page as a test sees it (T6).
// Sessions: the four sessions below belong to the seeded 2026 test events (Brazil and China). Their start times are set here,
// in the LOCAL database only, so that each of the four prediction forms is open, and put back afterwards.
// (The API visibility tests use the practice event, and the deadline tests later use the United States event, so nothing overlaps.)
const { expect } = require("@playwright/test");
const { LOCAL_URL } = require("./local-env");
const db = require("./local-db");

const SESSIONS = {
  sprintQualifying: { id: "china-2026-sprint_qualifying", eventId: "china-2026", opens: "interval '1 day'" },
  sprint: { id: "china-2026-sprint", eventId: "china-2026", opens: "interval '2 days'" },
  qualifying: { id: "brazil-2026-qualifying", eventId: "brazil-2026", opens: "interval '3 days'" },
  race: { id: "brazil-2026-race", eventId: "brazil-2026", opens: "interval '4 days'" }
};

// The seeded 2026 drivers. id = "2026-" + lower-case code.
const DRIVERS = {
  alb: "Alexander Albon", alo: "Fernando Alonso", ant: "Andrea Kimi Antonelli", bea: "Oliver Bearman", bor: "Gabriel Bortoleto",
  bot: "Valtteri Bottas", col: "Franco Colapinto", gas: "Pierre Gasly", had: "Isack Hadjar", ham: "Lewis Hamilton",
  hul: "Nico Hulkenberg", law: "Liam Lawson", lec: "Charles Leclerc", lin: "Arvid Lindblad", nor: "Lando Norris",
  oco: "Esteban Ocon", per: "Sergio Perez", pia: "Oscar Piastri", rus: "George Russell", sai: "Carlos Sainz",
  str: "Lance Stroll", ver: "Max Verstappen"
};

function driverId(code) { return "2026-" + code; }

// Opens the four sessions (start times in the future) and returns what is needed to put them back.
function openSessions() {
  const originals = {};
  for (const key of Object.keys(SESSIONS)) {
    const s = SESSIONS[key];
    originals[s.id] = db.psql("select coalesce(start_utc::text, '') from public.sessions where id = " + db.literal(s.id));
    db.psql("update public.sessions set start_utc = now() + " + s.opens + " where id = " + db.literal(s.id));
  }
  return originals;
}

function restoreSessions(originals) {
  for (const id of Object.keys(originals)) {
    const value = originals[id] === "" ? "null" : db.literal(originals[id]) + "::timestamptz";
    db.psql("update public.sessions set start_utc = " + value + " where id = " + db.literal(id));
  }
}

function eventName(eventId) {
  return db.psql("select name from public.events where id = " + db.literal(eventId));
}

// Signs the browser in as an API-created player, exactly as the site's own sign-in would have stored the session.
async function loginAs(context, user) {
  const key = "sb-" + new URL(LOCAL_URL).hostname.split(".")[0] + "-auth-token";
  await context.addInitScript(function (args) {
    try { window.localStorage.setItem(args.key, args.value); } catch (e) { /* storage unavailable */ }
  }, { key: key, value: JSON.stringify(user.session) });
}

// Opens the predictions page on one session by using the rail, like a player would.
async function openSession(page, session) {
  await page.goto("/predict.html");
  await expect(page.locator("#form-area")).toBeVisible();
  const button = page.locator('.pl-sess[data-id="' + session.id + '"]');
  if (!(await button.isVisible())) {
    await page.locator(".pl-event-select").selectOption(eventName(session.eventId));
  }
  await expect(button).toBeVisible();
  if ((await button.getAttribute("aria-current")) !== "true") { await button.click(); }
  await expect(button).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#pick-status")).not.toHaveText("");
}

// A form step by the words in its heading ("Fastest lap", "Step 2", "Top 8 ...").
function step(page, headingText) {
  return page.locator(".form-step").filter({ has: page.locator("h3", { hasText: headingText }) });
}

// A driver's tile or chip inside a step. The accessible name starts with the full name.
function driver(scope, code) {
  return scope.getByRole("button", { name: new RegExp("^" + DRIVERS[code] + ", ") });
}

async function tap(scope, codes) {
  for (const code of codes) { await driver(scope, code).click(); }
}

// The driver codes in the numbered position buttons of a step, in order (for example the Q3 order).
async function slotOrder(scope) {
  const labels = await scope.locator("button.slot").evaluateAll(function (buttons) {
    return buttons.map(function (b) { return b.getAttribute("aria-label"); });
  });
  return labels.map(function (label) {
    const name = /^Position \d+: (.*?)(?: \(withdrawn\))?\./.exec(label)[1];
    return Object.keys(DRIVERS).filter(function (code) { return DRIVERS[code] === name; })[0];
  });
}

async function save(page) {
  await page.locator("#save-button").click();
}

async function expectSaved(page) {
  await expect(page.locator("#pred-message")).toHaveText("Prediction saved. You can change it until the lock time.");
  await expect(page.locator("#pred-message")).toHaveClass(/\bok\b/);
  await expect(page.locator("#pick-status")).toHaveText("Prediction saved");
}

async function expectError(page, text) {
  await expect(page.locator("#pred-message")).toHaveText(text);
  await expect(page.locator("#pred-message")).toHaveClass(/\berror\b/);
}

// What the database holds for this player and session.
async function savedPicks(api, user, session) {
  const res = await api.get("predictions", "select=picks&user_id=eq." + user.id + "&session_id=eq." + session.id, user.token);
  expect(res.status).toBe(200);
  return res.body.length === 0 ? null : res.body[0].picks;
}

module.exports = { SESSIONS, DRIVERS, driverId, openSessions, restoreSessions, eventName, loginAs, openSession, step, driver, tap, slotOrder, save, expectSaved, expectError, savedPicks };
