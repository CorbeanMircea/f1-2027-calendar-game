// Lights Out: Admin "Driver changes" (driver substitutions). Milestone M2b.
// Select the Grand Prix, the outgoing driver and the replacement, review the affected sessions, confirm.
// Everything is saved by the database functions admin_preview_substitution, admin_register_substitution and
// admin_revert_substitution (migration 031). This file never writes a table directly and never touches predictions,
// results, scores or season data.
(function () {
  "use strict";

  // Set this to true once the prediction form shows the updated lineup (milestone M3). Until then, registering a
  // substitution for a session whose predictions are still open would stop players from saving a complete prediction,
  // so the screen asks for an explicit acknowledgement first.
  var FORM_AWARE = false;

  var cfg = window.APP_CONFIG || {};
  var section = document.getElementById("changes-admin");
  if (!section) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var els = {
    form: document.getElementById("changes-form"),
    list: document.getElementById("changes-list"),
    empty: document.getElementById("changes-empty"),
    message: document.getElementById("changes-message"),
    refresh: document.getElementById("changes-refresh")
  };

  var TYPE_LABELS = {
    sprint_qualifying: "Sprint Qualifying",
    sprint: "Sprint",
    qualifying: "Qualifying",
    race: "Race"
  };
  var TYPE_ORDER = { sprint_qualifying: 1, sprint: 2, qualifying: 3, race: 4 };

  var state = { events: [], drivers: [], busy: false, ticket: 0 };
  var f = {};   // form elements

  // ---------- helpers ----------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function setMessage(kind, text) {
    els.message.className = "message" + (kind ? " " + kind : "");
    els.message.textContent = text || "";
  }

  function when(iso) {
    if (!iso) { return "Time unknown"; }
    return new Date(iso).toLocaleString([], {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function stamp(iso) {
    return new Date(iso).toLocaleString([], {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function typeLabel(t) { return TYPE_LABELS[t] || t; }

  function driverLabel(d) {
    return d.code + " - " + d.full_name + " (" + d.team_name + ")" + (d.is_active ? "" : " [not on the standard grid]");
  }

  function eventLabel(e) {
    return "Round " + e.round + " - " + e.name + " (" + e.start_date + ")";
  }

  function field(id, label, control, hint) {
    var wrap = el("div", "field");
    var lab = el("label", "", label);
    lab.setAttribute("for", id);
    control.id = id;
    wrap.appendChild(lab);
    wrap.appendChild(control);
    if (hint) { wrap.appendChild(el("p", "step-hint", hint)); }
    return wrap;
  }

  function textInput(placeholder) {
    var input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    if (placeholder) { input.placeholder = placeholder; }
    return input;
  }

  function seasonDrivers() {
    var ev = currentEvent();
    if (!ev) { return []; }
    return state.drivers.filter(function (d) { return d.season === ev.season; });
  }

  function currentEvent() {
    var id = f.event ? f.event.value : "";
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === id) { return state.events[i]; }
    }
    return null;
  }

  function fillSelect(select, options, placeholder) {
    var keep = select.value;
    select.textContent = "";
    var first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    });
    var exists = options.some(function (o) { return o.value === keep; });
    select.value = exists ? keep : "";
  }

  function errorText(err, fallback) {
    return (err && err.message) ? err.message : fallback;
  }

  // ---------- the substitution form ----------

  function buildForm() {
    els.form.textContent = "";
    var box = el("div", "dc-form");

    f.event = document.createElement("select");
    f.out = document.createElement("select");
    f.inExisting = document.createElement("select");
    f.code = textInput("e.g. CAM");
    f.name = textInput("Full name");
    f.team = textInput("Team");
    f.number = textInput("Car number (optional)");
    f.api = textInput("Results-API driver id, e.g. rafael_camara");

    box.appendChild(field("dc-event", "1. Grand Prix", f.event));
    box.appendChild(field("dc-out", "2. Outgoing driver", f.out));

    var modeWrap = el("div", "field");
    modeWrap.appendChild(el("span", "dc-label", "3. Replacement driver"));
    var radios = el("div", "dc-radios");
    f.modeExisting = document.createElement("input");
    f.modeExisting.type = "radio";
    f.modeExisting.name = "dc-mode";
    f.modeExisting.value = "existing";
    f.modeNew = document.createElement("input");
    f.modeNew.type = "radio";
    f.modeNew.name = "dc-mode";
    f.modeNew.value = "new";
    f.modeNew.checked = true;
    var l1 = el("label", "dc-radio");
    l1.appendChild(f.modeExisting);
    l1.appendChild(document.createTextNode(" Driver already in the list"));
    var l2 = el("label", "dc-radio");
    l2.appendChild(f.modeNew);
    l2.appendChild(document.createTextNode(" New driver"));
    radios.appendChild(l1);
    radios.appendChild(l2);
    modeWrap.appendChild(radios);
    box.appendChild(modeWrap);

    f.existingBox = el("div", "dc-sub");
    f.existingBox.appendChild(field("dc-in-existing", "Driver", f.inExisting));
    box.appendChild(f.existingBox);

    f.newBox = el("div", "dc-sub");
    f.newBox.appendChild(el("p", "step-hint",
      "A new driver is added as a reserve: he can race this weekend but does not become a season-long pick."));
    f.newBox.appendChild(field("dc-code", "Three-letter code", f.code));
    f.newBox.appendChild(field("dc-name", "Full name", f.name));
    f.newBox.appendChild(field("dc-team", "Team", f.team));
    f.newBox.appendChild(field("dc-number", "Car number", f.number));
    f.newBox.appendChild(field("dc-api", "Results-API driver id", f.api,
      "Required. Results can only be imported for him with this id (the driverId used by the results feed)."));
    box.appendChild(f.newBox);

    f.reviewButton = el("button", "btn btn-primary", "Review affected sessions");
    f.reviewButton.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(f.reviewButton);
    box.appendChild(actions);

    f.preview = el("div", "dc-preview");
    box.appendChild(f.preview);
    els.form.appendChild(box);

    fillSelect(f.event, state.events.map(function (e) { return { value: e.id, label: eventLabel(e) }; }),
      state.events.length ? "Choose a Grand Prix" : "No upcoming scheduled Grand Prix");

    f.event.addEventListener("change", function () { refreshDriverOptions(); clearPreview(); });
    f.out.addEventListener("change", function () {
      var out = driverById(f.out.value);
      if (out && f.team.value.trim() === "") { f.team.value = out.team_name; }
      refreshExistingOptions();
      clearPreview();
    });
    f.inExisting.addEventListener("change", clearPreview);
    [f.code, f.name, f.team, f.number, f.api].forEach(function (i) { i.addEventListener("input", clearPreview); });
    f.modeExisting.addEventListener("change", modeChanged);
    f.modeNew.addEventListener("change", modeChanged);
    f.reviewButton.addEventListener("click", review);

    refreshDriverOptions();
    modeChanged();
  }

  function driverById(id) {
    for (var i = 0; i < state.drivers.length; i++) {
      if (state.drivers[i].id === id) { return state.drivers[i]; }
    }
    return null;
  }

  function refreshDriverOptions() {
    var list = seasonDrivers();
    fillSelect(f.out, list.map(function (d) { return { value: d.id, label: driverLabel(d) }; }),
      currentEvent() ? "Choose the outgoing driver" : "Choose a Grand Prix first");
    refreshExistingOptions();
  }

  function refreshExistingOptions() {
    var list = seasonDrivers().filter(function (d) { return d.id !== f.out.value; });
    fillSelect(f.inExisting, list.map(function (d) { return { value: d.id, label: driverLabel(d) }; }),
      "Choose the replacement driver");
  }

  function modeChanged() {
    var isNew = f.modeNew.checked;
    f.newBox.hidden = !isNew;
    f.existingBox.hidden = isNew;
    clearPreview();
  }

  function clearPreview() {
    state.ticket++;
    f.preview.textContent = "";
  }

  function newDriverFromForm() {
    return {
      code: f.code.value.trim().toUpperCase(),
      full_name: f.name.value.trim(),
      team_name: f.team.value.trim(),
      car_number: f.number.value.trim(),
      external_id: f.api.value.trim()
    };
  }

  function validateChoice() {
    if (!f.event.value) { return "Choose a Grand Prix."; }
    if (!f.out.value) { return "Choose the outgoing driver."; }
    if (f.modeExisting.checked) {
      if (!f.inExisting.value) { return "Choose the replacement driver."; }
      return "";
    }
    var n = newDriverFromForm();
    if (!/^[A-Z]{3}$/.test(n.code)) { return "The driver code must be three letters."; }
    if (!n.full_name) { return "Enter the new driver's name."; }
    if (!n.team_name) { return "Enter the new driver's team."; }
    if (!n.external_id) { return "Enter the results-API driver id."; }
    if (n.car_number && !/^[0-9]{1,2}$/.test(n.car_number)) { return "The car number must be between 1 and 99."; }
    return "";
  }

  // ---------- review ----------

  function review() {
    if (state.busy) { return; }
    var problem = validateChoice();
    if (problem) { setMessage("error", problem); return; }
    setMessage("", "");

    var ticket = ++state.ticket;
    var eventId = f.event.value;
    var outId = f.out.value;
    var inId = f.modeExisting.checked ? f.inExisting.value : null;
    f.preview.textContent = "";
    f.preview.appendChild(el("p", "placeholder", "Loading the sessions..."));

    Promise.all([
      client.rpc("admin_preview_substitution", { p_event_id: eventId, p_out_driver: outId, p_in_driver: inId }),
      client.from("prediction_windows").select("session_id, is_open").eq("event_id", eventId)
    ]).then(function (res) {
      if (ticket !== state.ticket) { return; }
      if (res[0].error) { throw res[0].error; }
      var open = {};
      (res[1].data || []).forEach(function (w) { open[w.session_id] = !!w.is_open; });
      renderPreview(res[0].data, open, ticket);
    }).catch(function (err) {
      if (ticket !== state.ticket) { return; }
      console.error(err);
      f.preview.textContent = "";
      setMessage("error", errorText(err, "Could not load the sessions."));
    });
  }

  function renderPreview(data, open, ticket) {
    f.preview.textContent = "";
    var ev = data.event;
    var inDriver = f.modeExisting.checked ? driverById(f.inExisting.value) : null;
    var inText = inDriver ? driverLabel(inDriver) : (f.code.value.trim().toUpperCase() + " - " + f.name.value.trim() + " (new driver)");

    f.preview.appendChild(el("h3", "dc-subtitle", "4. Review"));
    f.preview.appendChild(el("p", "dc-summary", ev.name + ": " + data.out.code + " - " + data.out.name + "  \u2192  " + inText));

    if (ev.status !== "scheduled") {
      f.preview.appendChild(el("p", "editor-message error", "This event is not scheduled, so a substitution cannot be registered."));
      return;
    }

    var table = el("div", "dc-sessions");
    var boxes = [];
    (data.sessions || []).forEach(function (s) {
      var row = el("label", "dc-session" + (s.eligible ? "" : " is-disabled"));
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!s.default_selected;
      cb.disabled = !s.eligible;
      cb.setAttribute("data-session", s.session_id);
      cb.setAttribute("data-unknown", s.needs_confirmation ? "1" : "");
      cb.setAttribute("data-open", open[s.session_id] ? "1" : "");
      boxes.push(cb);
      var text = el("span", "dc-session-text");
      text.appendChild(el("strong", "", typeLabel(s.session_type)));
      var timing = s.timing === "taken_place" ? "Already taken place" : (s.timing === "unknown" ? "Start time unknown" : "Upcoming");
      text.appendChild(el("span", "dc-session-meta", when(s.start_utc) + " \u00b7 " + timing + " \u00b7 " + s.predictions +
        (s.predictions === 1 ? " saved prediction" : " saved predictions")));
      if (s.reason) { text.appendChild(el("span", "dc-session-note", s.reason)); }
      row.appendChild(cb);
      row.appendChild(text);
      table.appendChild(row);
    });
    f.preview.appendChild(table);

    f.preview.appendChild(el("p", "step-hint",
      "Players who saved a prediction for a selected session are notified. Their saved predictions are never changed. " +
      "Sessions that have already taken place cannot be changed."));

    var noteInput = textInput("Optional note (for the history)");
    f.preview.appendChild(field("dc-note", "Note", noteInput));

    var warn = el("div", "dc-warning");
    warn.hidden = true;
    var ack = document.createElement("input");
    ack.type = "checkbox";
    var ackLabel = el("label", "dc-radio");
    ackLabel.appendChild(ack);
    ackLabel.appendChild(document.createTextNode(
      " I understand: until the prediction form update is live, players cannot save these predictions."));
    warn.appendChild(el("p", "", "Predictions for a selected session are still open. The prediction form does not yet show the " +
      "updated lineup, so players would be unable to save a complete prediction for it."));
    warn.appendChild(ackLabel);
    f.preview.appendChild(warn);

    var confirmButton = el("button", "btn btn-primary", "Confirm substitution");
    confirmButton.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(confirmButton);
    f.preview.appendChild(actions);

    function selected() { return boxes.filter(function (b) { return b.checked && !b.disabled; }); }

    function update() {
      var chosen = selected();
      var needsAck = !FORM_AWARE && chosen.some(function (b) { return b.getAttribute("data-open") === "1"; });
      warn.hidden = !needsAck;
      confirmButton.disabled = chosen.length === 0 || (needsAck && !ack.checked);
    }
    boxes.forEach(function (b) { b.addEventListener("change", update); });
    ack.addEventListener("change", update);
    update();

    confirmButton.addEventListener("click", function () {
      if (state.busy || ticket !== state.ticket) { return; }
      var chosen = selected();
      if (chosen.length === 0) { return; }
      var ids = chosen.map(function (b) { return b.getAttribute("data-session"); });
      var unknown = chosen.filter(function (b) { return b.getAttribute("data-unknown") === "1"; })
        .map(function (b) { return b.getAttribute("data-session"); });
      var names = chosen.map(function (b) {
        var s = (data.sessions || []).filter(function (x) { return x.session_id === b.getAttribute("data-session"); })[0];
        return typeLabel(s.session_type);
      }).join(", ");
      var ok = window.confirm("Register this substitution?\n\n" + ev.name + "\n" + data.out.code + " out, " + inText + " in\nSessions: " + names +
        "\n\nPlayers with a saved prediction for these sessions will be notified.");
      if (!ok) { return; }

      state.busy = true;
      confirmButton.disabled = true;
      setMessage("", "Saving...");
      client.rpc("admin_register_substitution", {
        p_event_id: ev.id,
        p_out_driver: data.out.id,
        p_in_driver: f.modeExisting.checked ? f.inExisting.value : null,
        p_new_driver: f.modeExisting.checked ? null : newDriverFromForm(),
        p_session_ids: ids,
        p_confirm_unknown: unknown,
        p_note: noteInput.value.trim() || null
      }).then(function (res) {
        state.busy = false;
        if (res.error) { throw res.error; }
        var out = res.data || {};
        setMessage("ok", "Substitution registered. " + (out.notified || 0) + (out.notified === 1 ? " player was" : " players were") +
          " notified. Reload this page before entering or correcting results for this event, so the new driver appears.");
        return Promise.all([loadDrivers(), loadHistory()]).then(function () { buildForm(); });
      }).catch(function (err) {
        state.busy = false;
        console.error(err);
        setMessage("error", errorText(err, "Could not register the substitution."));
        update();
      });
    });
  }

  // ---------- history ----------

  function latestBySession(rows) {
    var latest = {};
    rows.forEach(function (r) {
      if (!latest[r.session_id] || r.seq > latest[r.session_id].seq) { latest[r.session_id] = r; }
    });
    return latest;
  }

  function renderHistory(subs, actions, events, sessions, names) {
    els.list.textContent = "";
    els.empty.hidden = subs.length > 0;

    subs.forEach(function (sub) {
      var ev = events[sub.event_id] || { name: sub.event_id };
      var mine = actions.filter(function (a) { return a.substitution_id === sub.id; }).sort(function (a, b) { return a.seq - b.seq; });
      var latest = latestBySession(mine);
      var sessionIds = Object.keys(latest).sort(function (a, b) {
        return (TYPE_ORDER[(sessions[a] || {}).session_type] || 9) - (TYPE_ORDER[(sessions[b] || {}).session_type] || 9);
      });
      var applied = sessionIds.filter(function (id) { return latest[id].action === "apply"; });

      var card = el("div", "dc-card");
      var head = el("div", "dc-card-head");
      head.appendChild(el("strong", "", ev.name + ": " + (sub.out_info.code || sub.out_driver_id) + " \u2192 " + (sub.in_info.code || sub.in_driver_id)));
      card.appendChild(head);
      card.appendChild(el("p", "dc-meta", (sub.out_info.name || "") + "  \u2192  " + (sub.in_info.name || "") +
        (sub.in_info.team ? " (" + sub.in_info.team + ")" : "")));
      card.appendChild(el("p", "dc-meta", "Registered " + stamp(sub.registered_at) + " by " + (names[sub.registered_by] || "an administrator") +
        (sub.note ? " \u00b7 " + sub.note : "")));

      var chips = el("div", "dc-chips");
      sessionIds.forEach(function (id) {
        var on = latest[id].action === "apply";
        chips.appendChild(el("span", "dc-chip " + (on ? "is-on" : "is-off"),
          typeLabel((sessions[id] || {}).session_type || id) + (on ? ": applied" : ": reverted")));
      });
      card.appendChild(chips);

      var detail = document.createElement("details");
      detail.className = "dc-details";
      detail.appendChild(el("summary", "", "History (" + mine.length + ")"));
      mine.forEach(function (a) {
        detail.appendChild(el("p", "dc-log", stamp(a.acted_at) + " \u00b7 " + typeLabel((sessions[a.session_id] || {}).session_type || a.session_id) +
          " \u00b7 " + (a.action === "apply" ? "applied" : "reverted") + " by " + (names[a.acted_by] || "an administrator") +
          (a.reason ? " \u00b7 " + a.reason : "")));
      });
      card.appendChild(detail);

      if (applied.length > 0) {
        var revertHost = el("div", "dc-revert");
        var revertButton = el("button", "btn btn-small", "Revert");
        revertButton.type = "button";
        card.appendChild(revertButton);
        card.appendChild(revertHost);
        revertButton.addEventListener("click", function () {
          if (revertHost.firstChild) { revertHost.textContent = ""; return; }
          openRevert(revertHost, sub, ev, applied, sessions);
        });
      }
      els.list.appendChild(card);
    });
  }

  function openRevert(host, sub, ev, applied, sessions) {
    host.textContent = "";
    var box = el("div", "dc-revert-box");
    box.appendChild(el("p", "step-hint",
      "Only sessions that have not taken place are reverted, and only if no later substitution still applies to them. " +
      "Saved predictions are never changed."));
    var reason = textInput("Reason (required)");
    box.appendChild(field("dc-reason-" + sub.id, "Reason", reason));

    var unknownBoxes = [];
    applied.forEach(function (id) {
      var s = sessions[id];
      if (s && !s.start_utc) {
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.setAttribute("data-session", id);
        var lab = el("label", "dc-radio");
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(" Also revert " + typeLabel(s.session_type) + " (start time unknown)"));
        box.appendChild(lab);
        unknownBoxes.push(cb);
      }
    });

    var go = el("button", "btn btn-primary", "Confirm revert");
    go.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(go);
    box.appendChild(actions);
    host.appendChild(box);

    go.addEventListener("click", function () {
      if (state.busy) { return; }
      if (reason.value.trim().length < 3) { setMessage("error", "A reason of at least three characters is required."); return; }
      if (!window.confirm("Revert this substitution (" + ev.name + ")?\n\nPlayers with a saved prediction for the affected sessions will be notified.")) { return; }
      state.busy = true;
      go.disabled = true;
      setMessage("", "Saving...");
      client.rpc("admin_revert_substitution", {
        p_substitution_id: sub.id,
        p_reason: reason.value.trim(),
        p_session_ids: null,
        p_confirm_unknown: unknownBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute("data-session"); })
      }).then(function (res) {
        state.busy = false;
        if (res.error) { throw res.error; }
        var out = res.data || {};
        var skipped = (out.skipped || []).length;
        setMessage("ok", "Reverted " + (out.reverted_sessions || []).length + " session(s)" +
          (skipped ? "; " + skipped + " already taken place and left unchanged" : "") + ". " + (out.notified || 0) +
          (out.notified === 1 ? " player was" : " players were") + " notified.");
        return Promise.all([loadDrivers(), loadHistory()]).then(function () { buildForm(); });
      }).catch(function (err) {
        state.busy = false;
        console.error(err);
        go.disabled = false;
        setMessage("error", errorText(err, "Could not revert the substitution."));
      });
    });
  }

  // ---------- loading ----------

  function loadDrivers() {
    return client.from("drivers").select("id, season, code, full_name, team_name, car_number, is_active").order("code")
      .then(function (res) {
        if (res.error) { throw res.error; }
        state.drivers = res.data || [];
      });
  }

  function loadEvents() {
    var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return client.from("events").select("id, name, season, round, status, start_date, end_date")
      .eq("status", "scheduled").gte("end_date", yesterday).order("start_date").limit(30)
      .then(function (res) {
        if (res.error) { throw res.error; }
        state.events = res.data || [];
      });
  }

  function loadHistory() {
    return client.from("driver_substitutions")
      .select("id, event_id, out_driver_id, in_driver_id, out_info, in_info, note, registered_by, registered_at")
      .order("registered_at", { ascending: false }).limit(20)
      .then(function (res) {
        if (res.error) { throw res.error; }
        var subs = res.data || [];
        if (subs.length === 0) { renderHistory([], [], {}, {}, {}); return; }
        var ids = subs.map(function (s) { return s.id; });
        var eventIds = Array.from(new Set(subs.map(function (s) { return s.event_id; })));
        return Promise.all([
          client.from("driver_substitution_sessions")
            .select("seq, substitution_id, session_id, action, reason, acted_by, acted_at").in("substitution_id", ids).order("seq"),
          client.from("events").select("id, name").in("id", eventIds),
          client.from("sessions").select("id, event_id, session_type, start_utc").in("event_id", eventIds)
        ]).then(function (all) {
          if (all[0].error) { throw all[0].error; }
          if (all[1].error) { throw all[1].error; }
          if (all[2].error) { throw all[2].error; }
          var actions = all[0].data || [];
          var events = {};
          (all[1].data || []).forEach(function (e) { events[e.id] = e; });
          var sessions = {};
          (all[2].data || []).forEach(function (s) { sessions[s.id] = s; });
          var adminIds = Array.from(new Set(
            subs.map(function (s) { return s.registered_by; }).concat(actions.map(function (a) { return a.acted_by; }))
              .filter(function (x) { return !!x; })));
          var namesPromise = adminIds.length
            ? client.from("profiles").select("id, display_name").in("id", adminIds)
            : Promise.resolve({ data: [] });
          return namesPromise.then(function (p) {
            var names = {};
            ((p && p.data) || []).forEach(function (row) { names[row.id] = row.display_name; });
            renderHistory(subs, actions, events, sessions, names);
          });
        });
      });
  }

  function failure(err) {
    console.error(err);
    var text = (err && (err.message || "")) + " " + ((err && err.code) || "");
    setMessage("error", /does not exist|schema cache|PGRST20[0-9]|42P01/i.test(text)
      ? "Driver changes need the latest database update (031_substitutions_database.sql)."
      : "Could not load driver changes. Please reload the page.");
  }

  function loadAll() {
    return Promise.all([loadDrivers(), loadEvents()]).then(function () {
      buildForm();
      return loadHistory();
    });
  }

  els.refresh.addEventListener("click", function () {
    if (state.busy) { return; }
    setMessage("", "");
    loadAll().catch(failure);
  });

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) { return; }
    return client.rpc("is_admin").then(function (adminResult) {
      if (adminResult.error || adminResult.data !== true) { return; }
      section.hidden = false;
      return loadAll();
    });
  }).catch(failure);
})();