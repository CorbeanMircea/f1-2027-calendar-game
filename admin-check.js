// Lights Out: the Admin "Weekend check" tab.
// A checklist to go through before every race weekend: sessions and times, drivers and lineup (substitutions), grid penalties,
// results and the importer, scheduled jobs, players and reminders, season picks. The facts come from the database function
// admin_weekend_check (migration 038, read-only); this file turns them into ok / warning / problem lines.
// Two checks cannot be known by the database and are confirmed by hand (the official entry list and the announced penalties):
// the ticks are kept in this browser, per weekend.
//
// Load this file BEFORE admin-tabs.js: it adds its own section to the admin panel, and admin-tabs.js turns that into a tab.
(function () {
  "use strict";

  var panel = document.getElementById("admin-panel");
  if (!panel) { return; }

  var TYPE_LABEL = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };
  var JOBS = [
    { name: "import-results-every-30-min", label: "Results importer", maxAgeMin: 90 },
    { name: "import-session-times-daily", label: "Session times sync", maxAgeMin: 36 * 60 },
    { name: "send-push-reminders-every-15-min", label: "Push reminders", maxAgeMin: 60 }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  // ---------- small helpers (used by the checks) ----------

  function ago(ms) {
    var min = Math.round(Math.abs(ms) / 60000);
    var text;
    if (min < 60) { text = min + " min"; }
    else if (min < 48 * 60) { text = Math.floor(min / 60) + " h " + (min % 60) + " min"; }
    else { text = Math.round(min / 1440) + " days"; }
    return ms >= 0 ? text + " ago" : "in " + text;
  }

  function when(iso) {
    return new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function list(items) { return items.join(", "); }

  // ---------- the checks: facts in, rows out (no page, no database) ----------
  // status: ok, warn, bad, info, todo (a manual check not ticked yet)

  function evaluate(d, now, manual) {
    manual = manual || {};
    var groups = [];
    var ev = d.event;

    function group(title) { var g = { title: title, rows: [] }; groups.push(g); return g; }
    function row(g, status, title, detail, key) { g.rows.push({ status: status, title: title, detail: detail || "", manual: key || null }); }

    // --- schedule and times
    var g = group("Schedule and times");
    var expected = ["qualifying", "race"].concat(ev.has_sprint ? ["sprint_qualifying", "sprint"] : []);
    var have = d.sessions.map(function (s) { return s.type; });
    var missing = expected.filter(function (t) { return have.indexOf(t) === -1; });
    if (missing.length) {
      row(g, "bad", "Sessions missing", list(missing.map(function (t) { return TYPE_LABEL[t]; })) + " not in the database for " + ev.name + ".");
    } else {
      row(g, "ok", "All " + expected.length + " sessions exist", ev.has_sprint ? "Sprint weekend." : "");
    }
    var noTime = d.sessions.filter(function (s) { return !s.start_utc; });
    if (noTime.length) {
      row(g, "bad", "No start time for " + list(noTime.map(function (s) { return TYPE_LABEL[s.type] || s.type; })),
        "Predictions for these stay closed. The daily time sync should fill them in; otherwise set the time by hand.");
    } else if (d.sessions.length) {
      var locks = d.sessions.filter(function (s) { return s.type === "qualifying" || s.type === "sprint_qualifying"; })
        .map(function (s) { return Date.parse(s.start_utc); }).filter(function (ms) { return ms > now; }).sort(function (a, b) { return a - b; });
      row(g, "ok", "Every session has a start time",
        locks.length ? "Next prediction deadline: " + when(locks[0]) + " (" + ago(now - locks[0]) + ")." : "All prediction deadlines for this weekend have passed.");
    }

    // --- drivers and lineup
    g = group("Drivers and lineup");
    var active = d.drivers.active;
    if (active >= 20) { row(g, "ok", active + " active drivers for " + ev.season); }
    else if (active >= 17) { row(g, "warn", "Only " + active + " active drivers for " + ev.season, "A full grid is normally 20 or more."); }
    else { row(g, "bad", "Only " + active + " active drivers for " + ev.season, "Load the season's drivers before the weekend."); }

    if (d.drivers.missing_api_id.length) {
      row(g, "warn", d.drivers.missing_api_id.length + " active driver" + (d.drivers.missing_api_id.length === 1 ? " has" : "s have") + " no results-API id",
        list(d.drivers.missing_api_id) + ". The importer matches results by this id, so these drivers' results would be logged as errors.");
    } else {
      row(g, "ok", "Every active driver has a results-API id");
    }

    var small = d.sessions.filter(function (s) { return s.lineup === null || s.lineup < 17; });
    if (small.length) { row(g, "bad", "The lineup is too small for " + list(small.map(function (s) { return TYPE_LABEL[s.type] || s.type; })), "Check the drivers and substitutions."); }

    if (d.substitutions.length) {
      row(g, "info", d.substitutions.length + " driver change" + (d.substitutions.length === 1 ? "" : "s") + " registered for this weekend",
        list(d.substitutions.map(function (s) { return s.out + " \u2192 " + s.in + " (" + list(s.sessions.map(function (t) { return (TYPE_LABEL[t] || t); })) + ")"; })));
    } else {
      row(g, "info", "No driver changes registered for this weekend");
    }
    row(g, manual.entry ? "ok" : "todo", "I compared the official entry list with the lineup", "Look for replacements and reserves before predictions open.", "entry");

    // --- grid penalties
    g = group("Grid penalties");
    if (d.penalties.length) {
      row(g, "info", d.penalties.length + " grid penalt" + (d.penalties.length === 1 ? "y" : "ies") + " registered",
        list(d.penalties.map(function (p) { return p.driver + " (" + (TYPE_LABEL[p.session] || p.session) + ", " + (p.penalty_type === "places" ? p.places + " places" : p.penalty_type.replace(/_/g, " ")) + ")"; })));
    } else {
      row(g, "info", "No grid penalties registered for this weekend");
    }
    row(g, manual.penalties ? "ok" : "todo", "I checked the announced penalties", "Check again after Qualifying and after Sprint Qualifying.", "penalties");

    // --- results and importer
    g = group("Results and importer");
    if (d.past_without_result.length === 0) {
      row(g, "ok", "Every finished session has an approved result");
    } else {
      d.past_without_result.forEach(function (s) {
        var ageH = (now - Date.parse(s.start_utc)) / 3600000;
        var name = s.event + ", " + (TYPE_LABEL[s.type] || s.type);
        if (s.pending) { row(g, "warn", name + ": result waiting for your approval", "Open the Results tab."); }
        else if (ageH > 12) { row(g, "bad", name + ": no result imported", "It ended " + ago(now - Date.parse(s.start_utc)) + ". Check the import log; the results API may be late, or enter it by hand."); }
        else { row(g, "warn", name + ": no result yet", "It ended " + ago(now - Date.parse(s.start_utc)) + ". The importer tries every 30 minutes."); }
      });
    }

    var lastError = (d.importer.recent || []).filter(function (r) { return r.action === "error"; })[0];
    if (d.importer.errors_24h > 0) {
      var notFound = lastError && /Expected exactly one API race/.test(lastError.detail || "");
      row(g, "bad", d.importer.errors_24h + " importer error" + (d.importer.errors_24h === 1 ? "" : "s") + " for this weekend in the last 24 hours",
        notFound ? "The importer cannot find this weekend's race in the results API. Check the event's dates." : (lastError ? lastError.detail : ""));
    } else {
      row(g, "ok", "No importer errors for this weekend in the last 24 hours");
    }
    row(g, "info", d.importer.last_log_at ? "Last importer log: " + ago(now - Date.parse(d.importer.last_log_at)) : "The importer has not logged anything yet");

    if (d.jobs === null) {
      row(g, "info", "Scheduled jobs could not be read", "Check them in the Supabase dashboard (Integrations, Cron).");
    } else {
      JOBS.forEach(function (j) {
        var job = d.jobs.filter(function (x) { return x.name === j.name; })[0];
        if (!job) { row(g, "bad", j.label + ": job not found", "Expected a scheduled job named " + j.name + "."); return; }
        if (!job.active) { row(g, "bad", j.label + ": the job is switched off", j.name); return; }
        if (!job.last_run) { row(g, "warn", j.label + ": no run recorded yet", "Scheduled " + job.schedule + "."); return; }
        var ageMin = (now - Date.parse(job.last_run)) / 60000;
        if (ageMin > j.maxAgeMin) { row(g, "bad", j.label + ": last ran " + ago(now - Date.parse(job.last_run)), "It should have run more recently (" + job.schedule + ")."); }
        else if (job.last_status && job.last_status !== "succeeded") { row(g, "warn", j.label + ": the last run reported \u201c" + job.last_status + "\u201d", "Ran " + ago(now - Date.parse(job.last_run)) + "."); }
        else { row(g, "ok", j.label + ": ran " + ago(now - Date.parse(job.last_run))); }
      });
    }

    // --- players and reminders
    g = group("Players and reminders");
    var members = d.players.members;
    row(g, "info", members + " player" + (members === 1 ? "" : "s") + " in the league; " + d.players.predicted_this_weekend + " predicted something for this weekend");
    if (d.players.devices === 0) { row(g, "bad", "No reminder device registered", "Nobody will get reminders. Players turn them on from the Account page."); }
    else if (d.players.players_with_devices < members) { row(g, "warn", d.players.players_with_devices + " of " + members + " players have reminders on", d.players.devices + " devices in total."); }
    else { row(g, "ok", "All " + members + " players have reminders on", d.players.devices + " devices in total."); }

    // --- season picks
    if (d.season_picks) {
      var sp = d.season_picks;
      g = group("Season picks " + sp.season);
      if (!sp.drivers_loaded) { row(g, "info", "Waiting for the season's drivers", "The picks open when the drivers are loaded and every Round 1 session has a start time."); }
      else if (sp.is_open) { row(g, sp.picked < members ? "warn" : "ok", "The season picks are open: " + sp.picked + " of " + members + " players have picked",
        sp.lock_at ? "They close " + when(sp.lock_at) + " (" + ago(now - Date.parse(sp.lock_at)) + ")." : ""); }
      else if (sp.late_open) { row(g, "info", "Late picks are open (half value): " + sp.picked + " of " + members + " players have picked", sp.late_lock_at ? "They close " + when(sp.late_lock_at) + "." : ""); }
      else if (!sp.lock_at) { row(g, "info", "The season picks have no closing time yet", "It is set by the first Round 1 session time."); }
      else { row(g, "info", "The season picks are closed: " + sp.picked + " of " + members + " players picked"); }
    }

    var count = { bad: 0, warn: 0, todo: 0, ok: 0 };
    groups.forEach(function (x) { x.rows.forEach(function (r) { if (count[r.status] !== undefined) { count[r.status]++; } }); });
    return { groups: groups, counts: count };
  }

  window.LO_WEEKEND_CHECK = { evaluate: evaluate };

  // ---------- the section ----------

  var cfg = window.APP_CONFIG || {};
  var section = el("section", "ck");
  section.id = "check-admin";
  var head = el("div", "ck-head");
  head.appendChild(el("h2", "admin-section-title", "Weekend check"));
  var pick = el("label", "ck-pick", "Weekend ");
  var select = document.createElement("select");
  select.id = "ck-event";
  pick.appendChild(select);
  head.appendChild(pick);
  var again = el("button", "btn btn-small", "Check again");
  again.type = "button";
  head.appendChild(again);
  section.appendChild(head);
  var summary = el("p", "ck-summary");
  var stepper = el("div", "ck-stepper");
  var stepperLabel = el("span", "ck-step-label");
  var progress = el("div", "ck-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Weekend check progress");
  progress.setAttribute("aria-valuemin", "1");
  progress.setAttribute("aria-valuemax", "1");
  progress.setAttribute("aria-valuenow", "1");
  var progressFill = el("span", "ck-progress-fill");
  progress.appendChild(progressFill);
  stepper.appendChild(stepperLabel);
  stepper.appendChild(progress);
  stepper.hidden = true;
  var body = el("div", "ck-body");
  var stepActions = el("div", "ck-step-actions");
  stepActions.hidden = true;
  var previous = el("button", "btn ck-step-previous", "Previous");
  previous.type = "button";
  var next = el("button", "btn btn-primary ck-step-next", "Next step");
  next.type = "button";
  stepActions.appendChild(previous);
  stepActions.appendChild(next);
  var activeStep = 0;
  var activeStepCount = 0;
  previous.addEventListener("click", function () {
    if (activeStep > 0 && current) { activeStep--; render(current); }
  });
  next.addEventListener("click", function () {
    if (!current || activeStepCount === 0) { return; }
    activeStep = activeStep === activeStepCount - 1 ? 0 : activeStep + 1;
    render(current);
  });
  section.appendChild(summary);
  section.appendChild(stepper);
  section.appendChild(body);
  section.appendChild(stepActions);
  section.appendChild(el("p", "ck-note", "Run this before every race weekend, and again after Qualifying and after Sprint Qualifying. A warning needs a look; a problem needs fixing before the weekend."));
  panel.appendChild(section);

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    summary.textContent = "Site configuration is incomplete.";
    return;
  }
  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  var token = 0;
  var current = null;

  function manualKey(id) { return "lo-admin-check-" + id; }
  function readManual(id) {
    try { return JSON.parse(localStorage.getItem(manualKey(id)) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveManual(id, value) {
    try { localStorage.setItem(manualKey(id), JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function setBadge(counts) {
    var tab = document.getElementById("at-tab-check");
    if (!tab) { return; }
    var old = tab.querySelector(".at-badge");
    if (old) { old.remove(); }
    var n = counts.bad + counts.warn;
    if (n === 0) { return; }
    var badge = el("span", "at-badge" + (counts.bad === 0 ? " warn" : ""), String(n));
    tab.appendChild(badge);
  }

  var MARK = { ok: "\u2713", warn: "!", bad: "\u00d7", info: "\u2022", todo: "" };

  function render(data) {
    var manual = readManual(data.event.id);
    var result = evaluate(data, Date.now(), manual);
    activeStep = Math.min(activeStep, Math.max(0, result.groups.length - 1));
    body.textContent = "";

    var parts = [];
    if (result.counts.bad) { parts.push(result.counts.bad + " problem" + (result.counts.bad === 1 ? "" : "s")); }
    if (result.counts.warn) { parts.push(result.counts.warn + " warning" + (result.counts.warn === 1 ? "" : "s")); }
    if (result.counts.todo) { parts.push(result.counts.todo + " to confirm"); }
    summary.className = "ck-summary " + (result.counts.bad ? "bad" : (result.counts.warn || result.counts.todo ? "warn" : "ok"));
    summary.textContent = data.event.name + " (round " + data.event.round + ", " + data.event.season + "): " +
      (parts.length ? parts.join(", ") : "everything is in place") + ". Checked " + new Date(data.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".";

    var steps = result.groups;
    activeStepCount = steps.length;
    stepper.hidden = steps.length === 0;
    stepActions.hidden = steps.length === 0;
    if (steps.length) {
      var group = steps[activeStep];
      stepperLabel.textContent = "Step " + (activeStep + 1) + " of " + steps.length;
      progress.setAttribute("aria-valuemax", String(steps.length));
      progress.setAttribute("aria-valuenow", String(activeStep + 1));
      progress.setAttribute("aria-valuetext", "Step " + (activeStep + 1) + " of " + steps.length + ": " + group.title);
      progressFill.style.width = ((activeStep + 1) / steps.length * 100) + "%";
      previous.disabled = activeStep === 0;
      next.disabled = false;
      next.textContent = activeStep === steps.length - 1 ? "Review from start" : "Next step";

      var box = el("section", "ck-group");
      box.appendChild(el("h3", "", group.title));
      var ul = el("ul", "ck-rows");
      group.rows.forEach(function (r) {
        var li = el("li", "ck-row " + r.status);
        if (r.manual) {
          var label = el("label", "ck-manual");
          var box2 = document.createElement("input");
          box2.type = "checkbox";
          box2.id = "ck-manual-" + r.manual;
          box2.checked = !!manual[r.manual];
          box2.addEventListener("change", function () {
            var m = readManual(data.event.id);
            m[r.manual] = box2.checked;
            saveManual(data.event.id, m);
            render(data);
            var updated = document.getElementById(box2.id);
            if (updated) { updated.focus(); }
          });
          label.appendChild(box2);
          var text = el("span", "ck-text");
          text.appendChild(el("b", "", r.title));
          if (r.detail) { text.appendChild(el("span", "ck-detail", r.detail)); }
          label.appendChild(text);
          li.appendChild(label);
        } else {
          var mark = el("span", "ck-mark", MARK[r.status]);
          mark.setAttribute("aria-hidden", "true");
          li.appendChild(mark);
          var t = el("span", "ck-text");
          t.appendChild(el("b", "", r.title));
          if (r.detail) { t.appendChild(el("span", "ck-detail", r.detail)); }
          li.appendChild(t);
          var sr = el("span", "ck-sr", { ok: "OK", warn: "Warning", bad: "Problem", info: "Info" }[r.status] || "");
          li.appendChild(sr);
        }
        ul.appendChild(li);
      });
      box.appendChild(ul);
      body.appendChild(box);
    }
    setBadge(result.counts);
  }

  function load(eventId) {
    var my = ++token;
    summary.className = "ck-summary";
    summary.textContent = "Checking...";
    client.rpc("admin_weekend_check", { p_event_id: eventId || null }).then(function (res) {
      if (my !== token) { return; }
      if (res.error) { throw res.error; }
      current = res.data;
      if (select.options.length && select.value !== current.event.id) { select.value = current.event.id; }
      render(current);
    }).catch(function (err) {
      if (my !== token) { return; }
      console.error(err);
      body.textContent = "";
      summary.className = "ck-summary bad";
      summary.textContent = "Could not run the weekend check (" + (err && err.message ? err.message : "error") + "). Migration 038 must be applied.";
    });
  }

  function fillEvents(defaultId) {
    return client.from("events").select("id, name, round, season, start_date, end_date").lt("season", 9000).order("start_date", { ascending: true })
      .then(function (res) {
        if (res.error) { throw res.error; }
        var today = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
        var list = (res.data || []).filter(function (e) { return e.end_date >= today || e.id === defaultId; });
        if (list.length === 0) { list = res.data || []; }
        select.textContent = "";
        list.forEach(function (e) {
          var o = el("option", "", "Round " + e.round + " \u00b7 " + e.name + " (" + e.season + ")");
          o.value = e.id;
          select.appendChild(o);
        });
        if (defaultId) { select.value = defaultId; }
      });
  }

  select.addEventListener("change", function () { activeStep = 0; load(select.value); });
  again.addEventListener("click", function () { load(select.value || null); });

  // First load: the function picks the current or next weekend, then the list is filled around it.
  client.rpc("admin_weekend_check", { p_event_id: null }).then(function (res) {
    if (res.error) { throw res.error; }
    current = res.data;
    return fillEvents(current.event.id).then(function () { render(current); });
  }).catch(function (err) {
    console.error(err);
    summary.className = "ck-summary bad";
    summary.textContent = "Could not run the weekend check (" + (err && err.message ? err.message : "error") + "). Migration 038 must be applied.";
  });
})();
