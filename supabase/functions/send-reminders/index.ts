// Lights Out push reminders.
//
// Three ways to call it:
//   1. The 15-minute schedule (supabase/022_push_schedule.sql) with the x-import-secret header.
//      It asks the database who still has to predict before a deadline and sends them a notification.
//      It also delivers new change notices (driver substitutions, grid penalties) that have not been pushed yet.
//   2. A signed-in player pressing "Send a test" on the Account page: ?task=test with their login.
//   3. A signed-in admin: ?task=notices with their login. Delivers the pending change notices right away
//      (the Admin screens call it after registering a change; otherwise the schedule delivers them within 15 minutes).
//
// Secrets this function needs (Dashboard > Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (for example mailto:you@example.com)
//   IMPORT_SECRET is the same one the result importer already uses.
// Deploy with JWT verification OFF (the function checks the secret or the login itself).

const SITE_URL = "https://corbeanmircea.github.io/f1-2027-calendar-game/";

const TYPE_LABEL: Record<string, string> = {
  sprint_qualifying: "Sprint Qualifying",
  sprint: "Sprint",
  qualifying: "Qualifying",
  race: "the Race",
};

export type DueRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
  lock_id: string;
  kind: string; // "h3" (1 to 3 hours left) or "h1" (under one hour left)
  event_name: string;
  lock_at: string;
  missing: string[];
};

export type NoticeRow = {
  notification_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
  kind: string;
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>;
  created_at: string;
};

const SESSION_NAME: Record<string, string> = {
  sprint_qualifying: "Sprint Qualifying",
  sprint: "Sprint",
  qualifying: "Qualifying",
  race: "Race",
};

export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

export function reminderPayload(row: DueRow, now: Date = new Date()) {
  const minutes = Math.max(1, Math.round((new Date(row.lock_at).getTime() - now.getTime()) / 60000));
  const when = row.kind === "h1" || minutes < 60
    ? `in ${minutes} minute${minutes === 1 ? "" : "s"}`
    : `in about ${Math.round(minutes / 60)} hours`;
  const what = joinList(row.missing.map((t) => TYPE_LABEL[t] ?? t));
  return {
    title: `Predictions lock ${when}`,
    body: `${row.event_name}: you have not picked ${what} yet.`,
    url: "predict.html",
    tag: `lock-${row.lock_id}`,
  };
}

// deno-lint-ignore no-explicit-any
function penaltyWords(p: any): string {
  if (!p) return "a grid penalty";
  if (p.type === "places") return `${p.places}-place grid penalty`;
  if (p.type === "pit_lane") return "pit-lane start";
  return "start from the back of the grid";
}

// The push message for one in-app change notice. Informational only.
export function noticePayload(row: NoticeRow) {
  const p = row.payload ?? {};
  const gp: string = p.grand_prix ?? "Grand Prix";
  const code = (d: { code?: string } | undefined) => d?.code ?? "a driver";
  const sessions = joinList(((p.sessions ?? []) as string[]).map((t) => SESSION_NAME[t] ?? t));
  const session = SESSION_NAME[p.session as string] ?? "";
  const keep = "Your saved prediction is unchanged.";
  const note = "Predictions and scoring are not affected.";
  let title = `Update: ${gp}`;
  let body = `There is an update for this weekend. ${keep}`;
  switch (row.kind) {
    case "substitution":
      title = `Driver change: ${gp}`;
      body = `${code(p.out)} is replaced by ${code(p.in)} for ${sessions}. ${keep}`;
      break;
    case "substitution_reverted":
      title = `Driver change reverted: ${gp}`;
      body = `The replacement of ${code(p.out)} by ${code(p.in)} was reverted for ${sessions}. ${keep}`;
      break;
    case "grid_penalty":
      title = `Grid penalty: ${gp}`;
      body = `${code(p.driver)} (${session}): ${penaltyWords(p.penalty)}. ${note}`;
      break;
    case "grid_penalty_revoked":
      title = `Grid penalty withdrawn: ${gp}`;
      body = `${code(p.driver)} (${session}): the penalty was withdrawn. ${note}`;
      break;
    case "grid_penalty_updated":
      title = `Grid penalty corrected: ${gp}`;
      body = `${code(p.driver)} (${session}): now ${penaltyWords(p.penalty)}. ${note}`;
      break;
  }
  return { title, body, url: "predict.html", tag: `notice-${row.notification_id}` };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Env = { get(name: string): string | undefined };
// deno-lint-ignore no-explicit-any
type Deps = { createClient: (url: string, key: string) => any; webpush: any };

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    const url = new URL(req.url);
    const supabaseUrl = env.get("SUPABASE_URL");
    const serviceKey = env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pub = env.get("VAPID_PUBLIC_KEY");
    const priv = env.get("VAPID_PRIVATE_KEY");
    const subject = env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
    if (!supabaseUrl || !serviceKey || !pub || !priv) {
      return json({ error: "Push keys are not set up yet" }, 500);
    }

    const webpush = deps.webpush;
    webpush.setVapidDetails(subject, pub, priv);
    const db = deps.createClient(supabaseUrl, serviceKey);

    const secret = env.get("IMPORT_SECRET");
    const fromSchedule = !!secret && req.headers.get("x-import-secret") === secret;

    type Target = { endpoint: string; p256dh: string; auth: string };
    const send = async (t: Target, payload: unknown) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: "high" },
        );
        return "sent";
      } catch (e) {
        // deno-lint-ignore no-explicit-any
        const code = (e as any)?.statusCode;
        if (code === 404 || code === 410) {
          await db.from("push_subscriptions").delete().eq("endpoint", t.endpoint); // device is gone
          return "removed";
        }
        console.error("push failed", code, (e as Error)?.message);
        return "failed";
      }
    };

    // Delivers the change notices that have not been pushed to a device yet. Never delivers a notice twice to a device.
    const deliverNotices = async () => {
      const dueN = await db.rpc("due_push_notices");
      if (dueN.error) throw dueN.error;
      const rows: NoticeRow[] = dueN.data ?? [];
      const out = { due: rows.length, sent: 0, removed: 0, failed: 0 };
      for (let i = 0; i < rows.length; i += 10) {
        const outcomes = await Promise.all(rows.slice(i, i + 10).map(async (row) => {
          const result = await send(row, noticePayload(row));
          if (result === "sent") {
            await db.from("push_notice_log").upsert({ endpoint: row.endpoint, notification_id: row.notification_id });
            await db.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("endpoint", row.endpoint);
          }
          return result;
        }));
        for (const o of outcomes) {
          if (o === "sent") out.sent++;
          else if (o === "removed") out.removed++;
          else out.failed++;
        }
      }
      return out;
    };

    // ---- A signed-in player sends themselves a test, or a signed-in admin delivers the pending change notices ----
    if (!fromSchedule) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = token ? await db.auth.getUser(token) : null;
      const user = who?.data?.user;
      const task = url.searchParams.get("task");

      if (task === "notices" && user) {
        const admin = await db.from("group_members").select("role").eq("user_id", user.id).eq("role", "admin").limit(1);
        if (admin.error) throw admin.error;
        if (!admin.data || admin.data.length === 0) return json({ error: "Not authorised" }, 401);
        return json(await deliverNotices());
      }

      if (task !== "test" || !user) return json({ error: "Not authorised" }, 401);

      const subs = await db.from("push_subscriptions").select("endpoint, p256dh, auth").eq("user_id", user.id);
      if (subs.error) throw subs.error;
      const payload = {
        title: "Reminders are on",
        body: "You will get a message like this before a deadline if you have not predicted.",
        url: "predict.html",
        tag: "test",
      };
      const results = await Promise.all((subs.data ?? []).map((s: Target) => send(s, payload)));
      return json({ devices: results.length, sent: results.filter((r: string) => r === "sent").length });
    }

    // ---- The 15-minute schedule ----
    const due = await db.rpc("due_push_reminders");
    if (due.error) throw due.error;
    const rows: DueRow[] = due.data ?? [];
    const report = { due: rows.length, sent: 0, removed: 0, failed: 0 };

    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10);
      const outcomes = await Promise.all(batch.map(async (row) => {
        const result = await send(row, reminderPayload(row));
        if (result === "sent") {
          await db.from("push_log").upsert({ endpoint: row.endpoint, session_id: row.lock_id, kind: row.kind });
          await db.from("push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("endpoint", row.endpoint);
        }
        return result;
      }));
      for (const o of outcomes) {
        if (o === "sent") report.sent++;
        else if (o === "removed") report.removed++;
        else report.failed++;
      }
    }

    // New change notices (substitutions, grid penalties). A problem here never blocks the reminders above.
    let notices: unknown = null;
    try {
      notices = await deliverNotices();
    } catch (e) {
      console.error("change notices failed", (e as Error)?.message);
      notices = { error: "change notices failed" };
    }
    return json({ ...report, notices });
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong" }, 500);
  }
}

// deno-lint-ignore no-explicit-any
const D: any = (globalThis as any).Deno;
if (D && D.serve) {
  D.serve(async (req: Request) => {
    const { createClient } = await import("npm:@supabase/supabase-js@2.100.1");
    const webpush = (await import("npm:web-push@3.6.7")).default;
    return handle(req, D.env, { createClient, webpush });
  });
}
