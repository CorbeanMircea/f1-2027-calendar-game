// import-results (Milestone 15b: DRY RUN ONLY).
// Reads public results-API data and translates it into this project's result formats.
// It never writes to the database.

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
// everyone else on the full grid = Q1 knock-outs (drivers with no time are missing from the API list).
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
// (penalties can change the grid, so this must always be reviewed by a person).
function deriveSprintQualifying(rows: Row[]): Row {
  const ordered = rows.filter((r) => num(r.grid) >= 1).sort(byGrid).map(driverId);
  if (ordered.length < 17) { throw new Error("Not enough grid positions to derive sprint qualifying"); }
  return {
    q1_out: ordered.slice(16),
    q2_out: ordered.slice(10, 16),
    q3_order: ordered.slice(0, 10),
  };
}

function codeMap(...lists: Row[][]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const list of lists) {
    for (const row of list) {
      if (row && row.Driver) { map[driverId(row)] = String(row.Driver.code ?? driverId(row)); }
    }
  }
  return map;
}

function readable(value: Row, codes: Record<string, string>): Row {
  if (Array.isArray(value)) { return value.map((v) => codes[v] ?? v); }
  if (value && typeof value === "object") {
    const out: Row = {};
    for (const key of Object.keys(value)) { out[key] = readable(value[key], codes); }
    return out;
  }
  return codes[value as string] ?? value;
}

function attempt(rows: Row[], missingReason: string, build: () => Row, codes: Record<string, string>): Row {
  if (rows.length === 0) { return { status: "not available", reason: missingReason }; }
  try {
    const data = build();
    return { status: "ok", data, readable: readable(data, codes) };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  const expected = Deno.env.get("IMPORT_SECRET");
  if (!expected || url.searchParams.get("key") !== expected) {
    return json({ error: "Not authorised" }, 401);
  }

  const season = url.searchParams.get("season") ?? "";
  const round = url.searchParams.get("round") ?? "";
  if (!/^20[0-9]{2}$/.test(season) || !/^[0-9]{1,2}$/.test(round)) {
    return json({ error: "Use ?season=2026&round=1&key=YOUR_SECRET" }, 400);
  }

  try {
    const scheduleBody = await apiGet("/" + season + "/" + round + "/");
    const raceInfo = scheduleBody?.MRData?.RaceTable?.Races?.[0] ?? null;

    const resultsBody = await apiGet("/" + season + "/" + round + "/results/?limit=100");
    const raceRows: Row[] = resultsBody?.MRData?.RaceTable?.Races?.[0]?.Results ?? [];

    const qualifyingBody = await apiGet("/" + season + "/" + round + "/qualifying/?limit=100");
    const qualifyingRows: Row[] = qualifyingBody?.MRData?.RaceTable?.Races?.[0]?.QualifyingResults ?? [];

    const sprintBody = await apiGet("/" + season + "/" + round + "/sprint/?limit=100");
    const sprintRows: Row[] = sprintBody?.MRData?.RaceTable?.Races?.[0]?.SprintResults ?? [];

    const codes = codeMap(raceRows, qualifyingRows, sprintRows);
    const allIds = raceRows.map(driverId);

    const output: Row = {
      mode: "DRY RUN: nothing is saved",
      season: num(season),
      round: num(round),
      race_name: raceInfo?.raceName ?? null,
      schedule: raceInfo
        ? {
          qualifying: toIso(raceInfo.Qualifying),
          sprint_qualifying: toIso(raceInfo.SprintQualifying),
          sprint: toIso(raceInfo.Sprint),
          race: toIso(raceInfo),
        }
        : null,
      row_counts: {
        race: raceRows.length,
        qualifying: qualifyingRows.length,
        sprint: sprintRows.length,
      },
      qualifying: attempt(
        qualifyingRows,
        "No qualifying results yet",
        () => {
          if (allIds.length === 0) {
            throw new Error("Race results are needed in this dry run to list the full grid");
          }
          return buildQualifying(qualifyingRows, allIds);
        },
        codes,
      ),
      race: attempt(raceRows, "No race results yet", () => buildRace(raceRows), codes),
      sprint: attempt(sprintRows, "No sprint this weekend, or no results yet", () => buildSprint(sprintRows), codes),
      sprint_qualifying_derived: attempt(
        sprintRows,
        "No sprint this weekend, or no results yet",
        () => deriveSprintQualifying(sprintRows),
        codes,
      ),
    };

    return json(output);
  } catch (err) {
    return json({ error: (err as Error).message }, 502);
  }
});
