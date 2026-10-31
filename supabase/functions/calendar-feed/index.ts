// Lights Out calendar feed.
//
// A public calendar (.ics) that friends can subscribe to from Apple Calendar, Google Calendar or
// Outlook. By default it contains one entry per prediction deadline, with alarms one day and one
// hour before. Add ?mode=all to also include every session of each race weekend.
//
// It only contains the public race schedule, so it needs no login. Deploy with JWT verification
// turned OFF (dashboard: Edge Functions > calendar-feed > "Verify JWT" off, or
// `supabase functions deploy calendar-feed --no-verify-jwt`).

const SITE_URL = "https://corbeanmircea.github.io/f1-2027-calendar-game/";
const CRLF = "\r\n";

const SESSION_LABEL: Record<string, string> = {
  sprint_qualifying: "Sprint Qualifying",
  sprint: "Sprint",
  qualifying: "Qualifying",
  race: "Race",
};
const SESSION_MINUTES: Record<string, number> = { sprint_qualifying: 45, sprint: 45, qualifying: 60, race: 120 };

export function escapeText(text: string): string {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Lines longer than 75 bytes are folded; a continuation line starts with one space.
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // the leading space counts as one byte
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join(CRLF + " ");
}

export function utc(iso: string | number | Date): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function alarm(trigger: string, text: string): string[] {
  return ["BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:" + trigger, "DESCRIPTION:" + escapeText(text), "END:VALARM"];
}

export type EventRow = { id: string; name: string; round?: number; season?: number; locality?: string | null; country?: string | null };
export type SessionRow = { event_id: string; session_type: string; start_utc: string | null };

export function buildCalendar(events: EventRow[], sessions: SessionRow[], mode: string, now: Date): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lights Out//Prediction calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Lights Out predictions",
    "X-WR-CALDESC:Prediction deadlines and sessions for the Lights Out F1 friends league",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  const stamp = utc(now);

  for (const ev of events) {
    const mine = sessions.filter((s) => s.event_id === ev.id && s.start_utc);
    const byType = (t: string) => mine.find((s) => s.session_type === t);
    const place = [ev.locality, ev.country].filter(Boolean).join(", ");

    // Deadlines: qualifying locks Qualifying + Race; sprint qualifying locks Sprint Qualifying + Sprint.
    const locks = [
      { type: "qualifying", covers: "Qualifying and Race" },
      { type: "sprint_qualifying", covers: "Sprint Qualifying and Sprint" },
    ];
    for (const lock of locks) {
      const s = byType(lock.type);
      if (!s || !s.start_utc) continue;
      const start = new Date(s.start_utc);
      const end = new Date(start.getTime() + 15 * 60000);
      lines.push(
        "BEGIN:VEVENT",
        `UID:lock-${ev.id}-${lock.type}@lights-out`,
        "DTSTAMP:" + stamp,
        "DTSTART:" + utc(start),
        "DTEND:" + utc(end),
        "SUMMARY:" + escapeText(`Predictions lock: ${ev.name} (${lock.covers})`),
        "DESCRIPTION:" + escapeText(`Make or change your picks for ${lock.covers} before this time.\n${SITE_URL}predict.html`),
        "URL:" + SITE_URL + "predict.html",
        "CATEGORIES:Lights Out",
        "TRANSP:TRANSPARENT",
        ...alarm("-P1D", `Predictions for ${ev.name} lock tomorrow`),
        ...alarm("-PT1H", `Predictions for ${ev.name} lock in 1 hour`),
        "END:VEVENT",
      );
    }

    if (mode === "all") {
      for (const s of mine) {
        const start = new Date(s.start_utc as string);
        const minutes = SESSION_MINUTES[s.session_type] ?? 60;
        const end = new Date(start.getTime() + minutes * 60000);
        lines.push(
          "BEGIN:VEVENT",
          `UID:session-${ev.id}-${s.session_type}@lights-out`,
          "DTSTAMP:" + stamp,
          "DTSTART:" + utc(start),
          "DTEND:" + utc(end),
          "SUMMARY:" + escapeText(`${ev.name}: ${SESSION_LABEL[s.session_type] ?? s.session_type}`),
          ...(place ? ["LOCATION:" + escapeText(place)] : []),
          "CATEGORIES:Lights Out",
          "END:VEVENT",
        );
      }
    }
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join(CRLF) + CRLF;
}

// ---------- Web handler (runs only inside Supabase / Deno) ----------

// deno-lint-ignore no-explicit-any
const D: any = (globalThis as any).Deno;
if (D && D.serve) {
  D.serve(async (req: Request) => {
    try {
      const url = new URL(req.url);
      const mode = url.searchParams.get("mode") === "all" ? "all" : "locks";
      const { createClient } = await import("npm:@supabase/supabase-js@2.100.1");
      const db = createClient(D.env.get("SUPABASE_URL"), D.env.get("SUPABASE_SERVICE_ROLE_KEY"));

      const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
      const ev = await db.from("events").select("id, name, round, season, locality, country, status")
        .gte("end_date", cutoff).neq("status", "cancelled").order("start_date", { ascending: true });
      if (ev.error) throw ev.error;
      const ids = (ev.data ?? []).map((e: EventRow) => e.id);
      const se = ids.length
        ? await db.from("sessions").select("event_id, session_type, start_utc").in("event_id", ids)
        : { data: [], error: null };
      if (se.error) throw se.error;

      const body = buildCalendar(ev.data ?? [], se.data ?? [], mode, new Date());
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'inline; filename="lights-out.ics"',
          "cache-control": "public, max-age=900",
        },
      });
    } catch (err) {
      console.error(err);
      return new Response("The calendar is not available right now.", { status: 500 });
    }
  });
}
