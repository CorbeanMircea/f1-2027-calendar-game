// import-results (Milestone 15d).
//
//   task=results (default)  saves PENDING results for events in the current race weekend window
//   task=times              keeps session start times (lock deadlines) in step with the schedule
//
//   ?key=SECRET&task=results&event=australia-2026              dry run (nothing is saved)
//   ?key=SECRET&task=results&event=australia-2026&mode=import  saves pending results
//   ?key=SECRET&task=times&event=brazil-2026                   dry run of the time sync
//   ?key=SECRET&task=times&mode=import                         updates times for all upcoming events
//
// It never approves a result, never edits an event, and logs every change to import_log.

import { createClient } from "npm:@supabase/supabase-js@2.100.1";

const API = "https://api.jolpi.ca/ergast/f1";
const USER_AGENT = "F1FriendsLeague/1.0 (private friends prediction game)";

// deno-lint-ignore no-explicit-any
type Row = any;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function apiGet(path: string): Promise<Row> {
  const response = await fetch(API + path, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
  });
  if (!response.ok) {
    throw new Error("Results API returned HTTP " + response.status + " for " + path);
  }
  const body = await response.json();
  await sleep(350); // stay well below the burst limit of 4 requests per second
  return body;
}

function toIso(block: Row): string | null {
  if (!block || !block.date || !block.time) { return null; }
  const iso = block.date + "T" + block.time;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function driverId(row: Row): string {
  return String(row.Driver.driverId);
}

function num(value: unknown): number {
  return Number(value);
}

function isClassified(row: Row): boolean {
  return /^[0-9]+$/.test(String(row.positionText));
}

function byPosition(a: Row, b: Row): number {
  return num(a.position) - num(b.position);
}

function byGrid(a: Row, b: Row): number {
  return num(a.grid) - num(b.grid);
}

// Qualifying: top 10 = Q3 order, positions 11-16 = Q2 knock-outs,
// everyone else on our full grid = Q1 knock-outs (drivers with no time are missing from the API list).
function buildQualifying(rows: Row[], allIds: string[]): Row {
  const sorted = [...rows].sort(byPosition);
  const q3 = sorted.filter((r) => num(r.position) >= 1 && num(r.position) <= 10).map(driverId);
  const q2out = sorted.filter((r) => num(r.position) >= 11 && num(r.position) <= 16).map(driverId);
  if (q3.length !== 10 || q2out.length !== 6) {
    throw new Error(
      "Unexpected qualifying shape: " + q3.length + " drivers in Q3 and " + q2out.length + " knocked out in Q2",
    );
  }
  const placed = new Set([...q3, ...q2out]);
  const q1out = allIds.filter((id) => !placed.has(id));
  if (q1out.length !== allIds.length - 16) {
    throw new Error("Unexpected number of Q1 knock-outs: " + q1out.length);
  }
  return { q1_out: q1out, q2_out: q2out, q3_order: q3 };
}

// Race: top 8 classified finishers, the single fastest lap (rank 1), DNFs, and the real top-8 grid.
function buildRace(rows: Row[]): Row {
  const top8 = rows.filter(isClassified).sort(byPosition).slice(0, 8).map(driverId);
  if (top8.length !== 8) { throw new Error("Fewer than 8 classified finishers"); }

  const fastest = rows.filter((r) => r.FastestLap && String(r.FastestLap.rank) === "1");
  if (fastest.length !== 1) { throw new Error("Could not identify exactly one fastest lap"); }

  const dnf = rows
    .filter((r) => ["R", "N"].includes(String(r.positionText)) || r.status === "Retired")
    .map(driverId);
  if (dnf.some((id) => top8.includes(id))) {
    throw new Error("A DNF driver is also in the top 8");
  }

  const grid = rows.filter((r) => num(r.grid) >= 1).sort(byGrid).slice(0, 8).map(driverId);
  if (grid.length !== 8) { throw new Error("Fewer than 8 starting grid positions"); }

  return { top8, fastest_lap: driverId(fastest[0]), dnf_drivers: dnf, grid_top8: grid };
}

// Sprint: top 8 classified finishers.
function buildSprint(rows: Row[]): Row {
  const top8 = rows.filter(isClassified).sort(byPosition).slice(0, 8).map(driverId);
  if (top8.length !== 8) { throw new Error("Fewer than 8 classified sprint finishers"); }
  return { top8 };
}

// Sprint qualifying has no results feed. Derive it from the sprint starting grid
// (penalties can change the grid, so a person must always review it before approving).
function deriveSprintQualifying(rows: Row[], allIds: string[]): Row {
  const ordered = rows.filter((r) => num(r.grid) >= 1).sort(byGrid).map(driverId);
  const q3 = ordered.slice(0, 10);
  const q2out = ordered.slice(10, 16);
  if (q3.length !== 10 || q2out.length !== 6) {
    throw new Error("Not enough grid positions to derive sprint qualifying");
  }
  const placed = new Set([...q3, ...q2out]);
  const q1out = allIds.filter((id) => !placed.has(id));
  if (q1out.length !== allIds.length - 16) {
    throw new Error("Unexpected number of derived SQ1 knock-outs: " + q1out.length);
  }
  return { q1_out: q1out, q2_out: q2out, q3_order: q3 };
}

// Replace the API's driver ids with our own driver ids. Any unknown driver is an error.
function mapData(data: Row, extToOurs: Map<string, string>): Row {
  const convert = (external: string): string => {
    const ours = extToOurs.get(external);
    if (!ours) { throw new Error("Unmapped driver: " + external); }
    return ours;
  };
  const out: Row = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = Array.isArray(value) ? value.map((v: string) => convert(v)) : convert(value as string);
  }
  return out;
}

// Same JSON, regardless of key order.
function canonical(value: Row): string {
  if (Array.isArray(value)) { return "[" + value.map(canonical).join(",") + "]"; }
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function loadSchedule(season: number, cache: Map<string, Row[]>): Promise<Row[]> {
  let races = cache.get(String(season));
  if (!races) {
    const body = await apiGet("/" + season + "/races/?limit=100");
    races = (body?.MRData?.RaceTable?.Races ?? []) as Row[];
    cache.set(String(season), races);
  }
  return races;
}

// ---------- task: results ----------

async function processEvent(db: Row, ev: Row, apply: boolean, cache: Map<string, Row[]>): Promise<Row[]> {
  const report: Row[] = [];

  async function log(
    sessionType: string,
    action: string,
    detail: string,
    resultId: string | null = null,
    round: number | null = null,
  ): Promise<void> {
    report.push({ event: ev.id, session: sessionType, action, detail });
    if (apply) {
      await db.from("import_log").insert({
        season: ev.season,
        round,
        event_id: ev.id,
        session_type: sessionType,
        action,
        detail,
        result_id: resultId,
      });
    }
  }

  // Our drivers for this season, mapped by the API's driver id.
  const driversResult = await db.from("drivers").select("id, external_id, is_active").eq("season", ev.season);
  if (driversResult.error) {
    await log("all", "error", "Could not read drivers: " + driversResult.error.message);
    return report;
  }
  const extToOurs = new Map<string, string>();
  const activeExternal: string[] = [];
  for (const d of driversResult.data ?? []) {
    if (d.external_id) {
      extToOurs.set(d.external_id, d.id);
      if (d.is_active) { activeExternal.push(d.external_id); }
    }
  }
  if (extToOurs.size === 0) {
    await log("all", "error", "No drivers with an external id are loaded for season " + ev.season);
    return report;
  }

  // Find the API race that belongs to this event by DATE (not by round number).
  const races = await loadSchedule(ev.season, cache);
  const matches = races.filter((r) => r.date >= ev.start_date && r.date <= ev.end_date);
  if (matches.length !== 1) {
    await log(
      "all",
      "error",
      "Expected exactly one API race between " + ev.start_date + " and " + ev.end_date +
        ", found " + matches.length + ". The calendar may have changed; check the event.",
    );
    return report;
  }
  const round = num(matches[0].round);

  const raceRows: Row[] =
    (await apiGet("/" + ev.season + "/" + round + "/results/?limit=100"))?.MRData?.RaceTable?.Races?.[0]?.Results ?? [];
  const qualifyingRows: Row[] =
    (await apiGet("/" + ev.season + "/" + round + "/qualifying/?limit=100"))?.MRData?.RaceTable?.Races?.[0]
      ?.QualifyingResults ?? [];
  const sprintRows: Row[] = ev.has_sprint
    ? ((await apiGet("/" + ev.season + "/" + round + "/sprint/?limit=100"))?.MRData?.RaceTable?.Races?.[0]
      ?.SprintResults ?? [])
    : [];

  const wanted: { type: string; source: string; has: boolean; build: () => Row }[] = [
    {
      type: "qualifying",
      source: "jolpica",
      has: qualifyingRows.length > 0,
      build: () => buildQualifying(qualifyingRows, activeExternal),
    },
    { type: "race", source: "jolpica", has: raceRows.length > 0, build: () => buildRace(raceRows) },
  ];
  if (ev.has_sprint) {
    wanted.push({
      type: "sprint_qualifying",
      source: "jolpica-derived-sprint-grid",
      has: sprintRows.length > 0,
      build: () => deriveSprintQualifying(sprintRows, activeExternal),
    });
    wanted.push({ type: "sprint", source: "jolpica", has: sprintRows.length > 0, build: () => buildSprint(sprintRows) });
  }

  for (const w of wanted) {
    const sessionId = ev.id + "-" + w.type;
    if (!w.has) {
      await log(w.type, "skipped", "No results available yet", null, round);
      continue;
    }
    try {
      const data = mapData(w.build(), extToOurs);

      const latest = await db.from("results").select("id, version, status, data, api_snapshot")
        .eq("session_id", sessionId).order("version", { ascending: false }).limit(1);
      if (latest.error) { throw new Error(latest.error.message); }

      if (
        latest.data && latest.data.length > 0 &&
        canonical(latest.data[0].api_snapshot ?? latest.data[0].data) === canonical(data)
      ) {
        await log(
          w.type,
          "unchanged",
          "Latest result (version " + latest.data[0].version + ", " + latest.data[0].status + ") already matches",
          latest.data[0].id,
          round,
        );
        continue;
      }

      if (!apply) {
        await log(w.type, "would_create_pending", JSON.stringify(data), null, round);
        continue;
      }

      const saved = await db.rpc("enter_result", { p_session_id: sessionId, p_data: data, p_source: w.source });
      if (saved.error) { throw new Error(saved.error.message); }
      await log(w.type, "created_pending", "New pending result saved (source " + w.source + ")", saved.data, round);
    } catch (err) {
      await log(w.type, "error", (err as Error).message, null, round);
    }
  }

  return report;
}

// ---------- task: times ----------

async function syncEventTimes(
  db: Row,
  ev: Row,
  apply: boolean,
  cache: Map<string, Row[]>,
  nowMs: number,
): Promise<Row[]> {
  const report: Row[] = [];

  async function log(
    sessionType: string,
    action: string,
    detail: string,
    persist = true,
    round: number | null = null,
  ): Promise<void> {
    report.push({ event: ev.id, session: sessionType, action, detail });
    if (apply && persist) {
      await db.from("import_log").insert({
        season: ev.season,
        round,
        event_id: ev.id,
        session_type: sessionType,
        action,
        detail,
      });
    }
  }

  const races = await loadSchedule(ev.season, cache);
  if (races.length === 0) {
    const marker = "empty-" + ev.season;
    if (!cache.has(marker)) {
      cache.set(marker, []);
      await log("all", "skipped", "The results API has no schedule for season " + ev.season + " yet");
    }
    return report;
  }

  const matches = races.filter((r) => r.date >= ev.start_date && r.date <= ev.end_date);
  if (matches.length !== 1) {
    await log(
      "all",
      "error",
      "Expected exactly one API race between " + ev.start_date + " and " + ev.end_date +
        ", found " + matches.length + ". The calendar may have changed; check the event.",
    );
    return report;
  }
  const race = matches[0];
  const round = num(race.round);

  const apiHasSprint = !!(race.Sprint && race.Sprint.date);
  if (apiHasSprint !== !!ev.has_sprint) {
    await log(
      "all",
      "error",
      "Sprint mismatch: the API says " + (apiHasSprint ? "sprint weekend" : "no sprint") +
        " but our event says " + (ev.has_sprint ? "sprint weekend" : "no sprint") + ". Check the event.",
      true,
      round,
    );
  }

  const apiTimes: Record<string, string | null> = {
    qualifying: toIso(race.Qualifying),
    race: toIso(race),
    sprint_qualifying: toIso(race.SprintQualifying),
    sprint: toIso(race.Sprint),
  };

  const sessionsResult = await db.from("sessions").select("id, session_type, start_utc")
    .eq("event_id", ev.id).order("session_type", { ascending: true });
  if (sessionsResult.error) {
    await log("all", "error", "Could not read sessions: " + sessionsResult.error.message, true, round);
    return report;
  }

  for (const s of sessionsResult.data ?? []) {
    const apiIso = apiTimes[s.session_type];
    if (!apiIso) { continue; } // the API has no time for this session: leave ours alone
    const apiMs = Date.parse(apiIso);
    const currentMs: number | null = s.start_utc ? Date.parse(s.start_utc) : null;

    if (currentMs !== null && currentMs === apiMs) {
      await log(s.session_type, "unchanged", "Time already matches (" + apiIso + ")", false, round);
      continue;
    }
    if (currentMs !== null && nowMs >= currentMs) {
      await log(
        s.session_type,
        "skipped",
        "Locked: the session already started at " + s.start_utc + "; the API now says " + apiIso +
          ". Not changed.",
        true,
        round,
      );
      continue;
    }
    if (currentMs !== null && apiMs <= nowMs) {
      await log(
        s.session_type,
        "error",
        "The API time " + apiIso + " is in the past but our time " + s.start_utc +
          " is still in the future. Not changed; review manually.",
        true,
        round,
      );
      continue;
    }

    const isNew = currentMs === null;
    if (!apply) {
      await log(
        s.session_type,
        isNew ? "would_set" : "would_update",
        isNew ? "Would set " + apiIso : "Would change " + s.start_utc + " to " + apiIso,
        false,
        round,
      );
      continue;
    }

    const updated = await db.from("sessions").update({ start_utc: apiIso }).eq("id", s.id);
    if (updated.error) {
      await log(s.session_type, "error", "Could not update the time: " + updated.error.message, true, round);
    } else {
      await log(
        s.session_type,
        isNew ? "time_set" : "time_updated",
        isNew ? "Set to " + apiIso : "Changed from " + s.start_utc + " to " + apiIso,
        true,
        round,
      );
    }
  }

  return report;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  const expected = Deno.env.get("IMPORT_SECRET");
  const provided = req.headers.get("x-import-secret") ?? url.searchParams.get("key");
  if (!expected || provided !== expected) {
    return json({ error: "Not authorised" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Server configuration is incomplete" }, 500);
  }
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const apply = url.searchParams.get("mode") === "import";
  const task = url.searchParams.get("task") === "times" ? "times" : "results";
  const eventParam = url.searchParams.get("event");

  const nowMs = Date.now();
  const now = new Date(nowMs);
  const todayIso = now.toISOString().slice(0, 10);
  const yesterdayIso = new Date(nowMs - 86400000).toISOString().slice(0, 10);
  const threeDaysAgoIso = new Date(nowMs - 3 * 86400000).toISOString().slice(0, 10);

  const columns = "id, season, round, start_date, end_date, has_sprint, status";
  let events: Row[] = [];
  if (eventParam) {
    const found = await db.from("events").select(columns).eq("id", eventParam);
    if (found.error) { return json({ error: found.error.message }, 500); }
    events = found.data ?? [];
  } else if (task === "times") {
    // Every scheduled event that has not finished yet (season 9999 is practice data and is skipped).
    const found = await db.from("events").select(columns)
      .eq("status", "scheduled").lt("season", 9000).gte("end_date", yesterdayIso)
      .order("start_date", { ascending: true });
    if (found.error) { return json({ error: found.error.message }, 500); }
    events = found.data ?? [];
  } else {
    // Current race-weekend window: weekend started, and ended no more than 3 days ago.
    const found = await db.from("events").select(columns)
      .eq("status", "scheduled").lt("season", 9000).lte("start_date", todayIso).gte("end_date", threeDaysAgoIso);
    if (found.error) { return json({ error: found.error.message }, 500); }
    events = found.data ?? [];
  }

  const cache = new Map<string, Row[]>();
  const report: Row[] = [];
  for (const ev of events) {
    try {
      const part = task === "times"
        ? await syncEventTimes(db, ev, apply, cache, nowMs)
        : await processEvent(db, ev, apply, cache);
      report.push(...part);
    } catch (err) {
      const message = (err as Error).message;
      report.push({ event: ev.id, session: "all", action: "error", detail: message });
      if (apply) {
        await db.from("import_log").insert({
          season: ev.season,
          event_id: ev.id,
          session_type: "all",
          action: "error",
          detail: message,
        });
      }
    }
  }

  return json({
    task,
    mode: apply ? "APPLY: changes are saved" : "DRY RUN: nothing is saved",
    events_checked: events.length,
    report,
  });
});