// Lights Out championship standings.
//
// Returns the real Drivers' and Constructors' championship tables for one season, read from the same results API the
// importer uses (Jolpica). The Leaderboard page calls it, so the browser never talks to the results API directly.
//
// Call:   GET /functions/v1/championship-standings?season=2027   with the player's login in the Authorization header.
// Answer: { season, round, drivers: [{position, code, name, team, points, wins}], constructors: [{position, name, points, wins}],
//           fetched_at }. Before the first race of a season the lists are empty and round is null.
//
// Needs no secrets of its own (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase). It only checks that the
// caller is signed in. Deploy with JWT verification OFF, the same as send-reminders: the function checks the login itself and
// answers the browser's CORS preflight itself.
//   supabase functions deploy championship-standings --no-verify-jwt
// Answers are kept in memory for 10 minutes, so a few friends reloading the page cause very few calls to the results API.

const API = "https://api.jolpi.ca/ergast/f1";
const USER_AGENT = "LightsOut-friends-league/1.0 (private fan project)";
const CACHE_MS = 10 * 60 * 1000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, max-age=300", ...CORS },
  });
}

// deno-lint-ignore no-explicit-any
type Row = any;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type Standings = {
  season: number;
  round: number | null;
  drivers: { position: number; code: string | null; name: string; team: string; points: number; wins: number }[];
  constructors: { position: number; name: string; points: number; wins: number }[];
};

// Turns the two API answers into the compact shape the page uses.
export function buildStandings(season: number, driversJson: Row, constructorsJson: Row): Standings {
  const dl: Row = driversJson?.MRData?.StandingsTable?.StandingsLists?.[0];
  const cl: Row = constructorsJson?.MRData?.StandingsTable?.StandingsLists?.[0];

  const drivers = ((dl?.DriverStandings ?? []) as Row[]).map((r: Row, i: number) => ({
    position: num(r.position) || i + 1,
    code: r.Driver?.code ? String(r.Driver.code).toUpperCase() : null,
    name: [r.Driver?.givenName, r.Driver?.familyName].filter(Boolean).join(" "),
    team: ((r.Constructors ?? []) as Row[]).map((c: Row) => c.name).filter(Boolean).join(" / "),
    points: num(r.points),
    wins: num(r.wins),
  }));

  const constructors = ((cl?.ConstructorStandings ?? []) as Row[]).map((r: Row, i: number) => ({
    position: num(r.position) || i + 1,
    name: String(r.Constructor?.name ?? ""),
    points: num(r.points),
    wins: num(r.wins),
  }));

  const roundText = dl?.round ?? cl?.round;
  return { season, round: roundText ? num(roundText) : null, drivers, constructors };
}

type Deps = {
  // deno-lint-ignore no-explicit-any
  createClient: (url: string, key: string) => any;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
type Env = { get(name: string): string | undefined };

const cache = new Map<number, { at: number; body: Standings & { fetched_at: string } }>();

async function apiGet(path: string, deps: Deps): Promise<Row> {
  const response = await deps.fetch(API + path, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" } });
  if (!response.ok) throw new Error("Results API returned HTTP " + response.status + " for " + path);
  return await response.json();
}

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "Use GET." }, 405);

  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season"));
    if (!Number.isInteger(season) || season < 1950 || season > 2100) return json({ error: "Give a season, for example ?season=2027." }, 400);

    // Only signed-in players may read it.
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Sign in first." }, 401);
    const db = deps.createClient(env.get("SUPABASE_URL") ?? "", env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const who = await db.auth.getUser(token);
    if (who.error || !who.data?.user) return json({ error: "Sign in first." }, 401);

    const hit = cache.get(season);
    if (hit && deps.now() - hit.at < CACHE_MS) return json(hit.body);

    const driversJson = await apiGet(`/${season}/driverstandings/?limit=100`, deps);
    await deps.sleep(350); // stay well below the results API's burst limit
    const constructorsJson = await apiGet(`/${season}/constructorstandings/?limit=100`, deps);

    const body = { ...buildStandings(season, driversJson, constructorsJson), fetched_at: new Date(deps.now()).toISOString() };
    cache.set(season, { at: deps.now(), body });
    return json(body);
  } catch (err) {
    console.error(err);
    return json({ error: "The championship standings are not available right now." }, 502);
  }
}

// deno-lint-ignore no-explicit-any
const D: any = (globalThis as any).Deno;
if (D && D.serve) {
  D.serve(async (req: Request) => {
    const { createClient } = await import("npm:@supabase/supabase-js@2.100.1");
    return handle(req, D.env, {
      createClient,
      fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    });
  });
}
