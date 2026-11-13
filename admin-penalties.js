// Lights Out: Admin "Grid penalties". Milestone M4.
// Select the Grand Prix, the session (Sprint or Race), the driver, the penalty and the reason, review, confirm.
// A grid penalty is an informational record: it never changes a result, a classification, a prediction or a score.
// Everything is saved by the database functions admin_preview_grid_penalty, admin_register_grid_penalty and
// admin_revoke_grid_penalty (migration 034). This file never writes a table directly.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var section = document.getElementById("penalties-admin");
  if (!section) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var els = {
    form: document.getElementById("penalties-form"),
    list: document.getElementById("penalties-list"),
    empty: document.getElementById("penalties-empty"),
    message: document.getElementById("penalties-message"),
    refresh: document.getElementById("penalties-refresh")
  };

  var SESSION_LABELS = { sprint: "Sprint", race: "Race" };
  var PENALTY_LABELS = {
    places: "Grid places",
    back_of_grid: "Start from the back of the grid",
    pit_lane: "Pit-lane start"
  };

  var state = { events: [], drivers: [], busy: false, ticket: 0 };
  var f = {};

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
    if (!iso) { return "start time unknown"; }
    return new Date(iso).toLocaleString([], {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function stamp(iso) {
    return new Date(iso).toLocaleString([], {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  // Ask the push function to deliver the new change notices right away (otherwise the 15-minute schedule does).
  // Best effort: a failure here changes nothing.
  function flushPush() {
    client.auth.getSession().then(function (r) {
      var s = r.data && r.data.session;
      if (!s) { return null; }
      var base = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
      return window.fetch(base + "/functions/v1/send-reminders?task=notices", {
        headers: { authorization: "Bearer " + s.access_token, apikey: cfg.SUPABASE_PUBLISHABLE_KEY }
      });
    }).catch(function () { /* the schedule delivers it anyway */ });
  }

  function errorText(err, fallback) {
    return (err && err.message) ? err.message : fallback;
  }

  function driverById(id) {
    for (var i = 0; i < state.drivers.length; i++) {
      if (state.drivers[i].id === id) { return state.drivers[i]; }
    }
    return null;
  }

  function driverLabel(d) {
    return d.code + " - " + d.full_name + " (" + d.team_name + ")";
  }

  function penaltyText(type, places) {
    if (type === "places") { return places + "-place grid penalty"; }
    if (type === "pit_lane") { return "Pit-lane start"; }
    return "Start from the back of the grid";
  }

  function positionsText(original, adjusted) {
    if (original && adjusted) { return " (from P" + original + " to P" + adjusted + ")"; }
    if (adjusted) { return " (starts P" + adjusted + ")"; }
    if (original) { return " (was P" + original + ")"; }
    return "";
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

  function numberInput(placeholder) {
    var input = textInput(placeholder);
    input.inputMode = "numeric";
    return input;
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
    select.value = options.some(function (o) { return o.value === keep; }) ? keep : "";
  }

  function typeSelect() {
    var select = document.createElement("select");
    Object.keys(PENALTY_LABELS).forEach(function (key) {
      var opt = document.createElement("option");
      opt.value = key;
      opt.textContent = PENALTY_LABELS[key];
      select.appendChild(opt);
    });
    return select;
  }

  function intOrNull(text) {
    var t = String(text || "").trim();
    return /^[0-9]{1,2}$/.test(t) ? parseInt(t, 10) : null;
  }

  // Checks the shared penalty fields; returns an error text or "".
  function checkPenaltyFields(type, places, original, adjusted, reason) {
    if (type === "places") {
      var n = intOrNull(places);
      if (n === null || n < 1 || n > 22) { return "Enter the number of grid places (1 to 22)."; }
    }
    if (String(original || "").trim() !== "" && (intOrNull(original) === null || intOrNull(original) < 1)) {
      return "The original start position must be a number from 1 to 30.";
    }
    if (String(adjusted || "").trim() !== "" && (intOrNull(adjusted) === null || intOrNull(adjusted) < 1)) {
      return "The adjusted start position must be a number from 1 to 30.";
    }
    if (String(reason || "").trim().length < 3) { return "Enter the reason or the official information."; }
    return "";
  }

  // ---------- the penalty form ----------

  function buildForm() {
    els.form.textContent = "";
    var box = el("div", "dc-form");

    f.event = document.createElement("select");
    f.session = document.createElement("select");
    f.driver = document.createElement("select");
    f.type = typeSelect();
    f.places = numberInput("e.g. 5 or 10");
    f.original = numberInput("Optional");
    f.adjusted = numberInput("Optional");
    f.reason = textInput("Reason or official information (required)");
    f.reference = textInput("Optional source, e.g. a link");

    box.appendChild(field("pn-event", "1. Grand Prix", f.event));
    box.appendChild(field("pn-session", "2. Session", f.session));
    box.appendChild(field("pn-driver", "3. Affected driver", f.driver));
    box.appendChild(field("pn-type", "4. Penalty", f.type));
    f.placesWrap = field("pn-places", "Number of grid places", f.places);
    box.appendChild(f.placesWrap);
    box.appendChild(field("pn-original", "Original start position", f.original,
      "Optional. Where he would have started without the penalty, if known."));
    box.appendChild(field("pn-adjusted", "Adjusted start position", f.adjusted,
      "Optional. Where he starts after the penalty, if known. Leave empty for a pit-lane start."));
    box.appendChild(field("pn-reason", "5. Reason or official information", f.reason));
    box.appendChild(field("pn-reference", "Source", f.reference));

    f.reviewButton = el("button", "btn btn-primary", "Review penalty");
    f.reviewButton.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(f.reviewButton);
    box.appendChild(actions);
    f.preview = el("div", "dc-preview");
    box.appendChild(f.preview);
    els.form.appendChild(box);

    fillSelect(f.event, state.events.map(function (e) {
      return { value: e.id, label: "Round " + e.round + " - " + e.name + " (" + e.start_date + ")" };
    }), state.events.length ? "Choose a Grand Prix" : "No upcoming scheduled Grand Prix");
    fillSelect(f.session, [], "Choose a Grand Prix first");
    fillSelect(f.driver, [], "Choose a session first");

    f.event.addEventListener("change", function () { clearPreview(); loadSessions(); });
    f.session.addEventListener("change", function () { clearPreview(); loadDrivers(); });
    [f.driver, f.type, f.places, f.original, f.adjusted, f.reason, f.reference].forEach(function (c) {
      c.addEventListener("input", clearPreview);
      c.addEventListener("change", clearPreview);
    });
    f.type.addEventListener("change", typeChanged);
    f.reviewButton.addEventListener("click", review);
    typeChanged();
  }

  function typeChanged() {
    f.placesWrap.hidden = f.type.value !== "places";
  }

  function clearPreview() {
    state.ticket++;
    f.preview.textContent = "";
  }

  function loadSessions() {
    var eventId = f.event.value;
    fillSelect(f.session, [], eventId ? "Loading..." : "Choose a Grand Prix first");
    fillSelect(f.driver, [], "Choose a session first");
    if (!eventId) { return; }
    client.from("sessions").select("id, session_type, start_utc").eq("event_id", eventId)
      .in("session_type", ["sprint", "race"]).order("session_type", { ascending: false })
      .then(function (res) {
        if (res.error) { throw res.error; }
        if (f.event.value !== eventId) { return; }
        fillSelect(f.session, (res.data || []).map(function (s) {
          return { value: s.id, label: SESSION_LABELS[s.session_type] + " (" + when(s.start_utc) + ")" };
        }), "Choose a session");
      }).catch(function (err) {
        console.error(err);
        setMessage("error", errorText(err, "Could not load the sessions."));
      });
  }

  function loadDrivers() {
    var sessionId = f.session.value;
    fillSelect(f.driver, [], sessionId ? "Loading..." : "Choose a session first");
    if (!sessionId) { return; }
    client.rpc("session_lineup", { p_session_id: sessionId }).then(function (res) {
      if (res.error) { throw res.error; }
      if (f.session.value !== sessionId) { return; }
      var ids = res.data || [];
      var list = state.drivers.filter(function (d) { return ids.indexOf(d.id) !== -1; });
      fillSelect(f.driver, list.map(function (d) { return { value: d.id, label: driverLabel(d) }; }), "Choose the driver");
    }).catch(function (err) {
      console.error(err);
      setMessage("error", errorText(err, "Could not load the lineup."));
    });
  }

  // ---------- review and confirm ----------

  function review() {
    if (state.busy) { return; }
    if (!f.event.value || !f.session.value || !f.driver.value) {
      setMessage("error", "Choose the Grand Prix, the session and the driver.");
      return;
    }
    var problem = checkPenaltyFields(f.type.value, f.places.value, f.original.value, f.adjusted.value, f.reason.value);
    if (problem) { setMessage("error", problem); return; }
    setMessage("", "");

    var ticket = ++state.ticket;
    var sessionId = f.session.value;
    f.preview.textContent = "";
    f.preview.appendChild(el("p", "placeholder", "Loading..."));

    client.rpc("admin_preview_grid_penalty", { p_session_id: sessionId }).then(function (res) {
      if (ticket !== state.ticket) { return; }
      if (res.error) { throw res.error; }
      renderPreview(res.data, ticket);
    }).catch(function (err) {
      if (ticket !== state.ticket) { return; }
      console.error(err);
      f.preview.textContent = "";
      setMessage("error", errorText(err, "Could not review the penalty."));
    });
  }

  function renderPreview(data, ticket) {
    f.preview.textContent = "";
    var driver = driverById(f.driver.value);
    var what = penaltyText(f.type.value, intOrNull(f.places.value)) + positionsText(intOrNull(f.original.value), intOrNull(f.adjusted.value));
    var sessionName = SESSION_LABELS[data.session.session_type] || data.session.session_type;

    f.preview.appendChild(el("h3", "dc-subtitle", "6. Review"));
    f.preview.appendChild(el("p", "dc-summary", data.event.name + " - " + sessionName + ": " + driver.code + " - " + driver.full_name + ", " + what));
    f.preview.appendChild(el("p", "dc-meta", "Session: " + when(data.session.start_utc) + " \u00b7 " + data.predictions +
      (data.predictions === 1 ? " saved prediction" : " saved predictions")));

    if (!data.eligible) {
      f.preview.appendChild(el("p", "editor-message error", data.reason || "This penalty cannot be registered."));
      return;
    }

    if (data.penalties && data.penalties.length > 0) {
      f.preview.appendChild(el("p", "step-hint", "Already registered for this session:"));
      data.penalties.forEach(function (p) {
        f.preview.appendChild(el("p", "dc-log", p.driver.code + ": " + penaltyText(p.penalty_type, p.places) +
          positionsText(p.original_position, p.adjusted_position) + " \u00b7 " + p.reason));
      });
    }

    f.preview.appendChild(el("p", "step-hint",
      "A grid penalty changes the starting position only. It does not change the qualifying or sprint classification, " +
      "the final result, any saved prediction or any score. Players who saved a prediction for this session are notified."));

    var ack = document.createElement("input");
    ack.type = "checkbox";
    var ackWrap = el("div", "dc-warning");
    ackWrap.hidden = !data.needs_confirmation;
    var ackLabel = el("label", "dc-radio");
    ackLabel.appendChild(ack);
    ackLabel.appendChild(document.createTextNode(" The start time of this session is unknown. Register the penalty anyway."));
    ackWrap.appendChild(ackLabel);
    f.preview.appendChild(ackWrap);

    var confirmButton = el("button", "btn btn-primary", "Confirm penalty");
    confirmButton.type = "button";
    confirmButton.disabled = !!data.needs_confirmation;
    var actions = el("div", "actions");
    actions.appendChild(confirmButton);
    f.preview.appendChild(actions);
    ack.addEventListener("change", function () { confirmButton.disabled = !ack.checked; });

    confirmButton.addEventListener("click", function () {
      if (state.busy || ticket !== state.ticket) { return; }
      var ok = window.confirm("Register this grid penalty?\n\n" + data.event.name + " - " + sessionName + "\n" + driver.code + ": " + what +
        "\n\nPlayers with a saved prediction for this session will be notified. Predictions and scoring are not affected.");
      if (!ok) { return; }
      state.busy = true;
      confirmButton.disabled = true;
      setMessage("", "Saving...");
      client.rpc("admin_register_grid_penalty", {
        p_session_id: data.session.id,
        p_driver: f.driver.value,
        p_penalty_type: f.type.value,
        p_places: f.type.value === "places" ? intOrNull(f.places.value) : null,
        p_original: intOrNull(f.original.value),
        p_adjusted: intOrNull(f.adjusted.value),
        p_reason: f.reason.value.trim(),
        p_reference: f.reference.value.trim() || null,
        p_confirm_unknown: !!ack.checked
      }).then(function (res) {
        state.busy = false;
        if (res.error) { throw res.error; }
        var out = res.data || {};
        flushPush();
        setMessage("ok", "Grid penalty registered. " + (out.notified || 0) + (out.notified === 1 ? " player was" : " players were") + " notified.");
        return loadHistory().then(function () { buildForm(); });
      }).catch(function (err) {
        state.busy = false;
        console.error(err);
        confirmButton.disabled = false;
        setMessage("error", errorText(err, "Could not register the penalty."));
      });
    });
  }

  // ---------- history, revoke and correct ----------

  function renderHistory(rows, events, sessions, names) {
    els.list.textContent = "";
    var revokedBy = {};
    rows.forEach(function (r) { if (r.entry_type === "revocation") { revokedBy[r.revokes_id] = r; } });
    var penalties = rows.filter(function (r) { return r.entry_type === "penalty"; });
    els.empty.hidden = penalties.length > 0;

    penalties.forEach(function (p) {
      var s = sessions[p.session_id] || {};
      var ev = events[s.event_id] || { name: s.event_id || "" };
      var d = driverById(p.driver_id);
      var rev = revokedBy[p.id];

      var card = el("div", "dc-card");
      card.appendChild(el("strong", "", ev.name + " - " + (SESSION_LABELS[s.session_type] || s.session_type) + ": " +
        (d ? d.code : p.driver_id) + ", " + penaltyText(p.penalty_type, p.places) + positionsText(p.original_position, p.adjusted_position)));
      card.appendChild(el("p", "dc-meta", (d ? d.full_name : "") + " \u00b7 " + p.reason + (p.reference ? " \u00b7 " + p.reference : "")));
      card.appendChild(el("p", "dc-meta", "Registered " + stamp(p.registered_at) + " by " + (names[p.registered_by] || "an administrator")));

      var chips = el("div", "dc-chips");
      chips.appendChild(el("span", "dc-chip " + (rev ? "is-off" : "is-on"), rev ? "Revoked" : "In force"));
      card.appendChild(chips);
      if (rev) {
        card.appendChild(el("p", "dc-log", "Revoked " + stamp(rev.registered_at) + " by " + (names[rev.registered_by] || "an administrator") + " \u00b7 " + rev.reason));
      } else {
        var button = el("button", "btn btn-small", "Revoke or correct");
        button.type = "button";
        var host = el("div", "dc-revert");
        card.appendChild(button);
        card.appendChild(host);
        button.addEventListener("click", function () {
          if (host.firstChild) { host.textContent = ""; return; }
          openRevoke(host, p, ev, s);
        });
      }
      els.list.appendChild(card);
    });
  }

  function openRevoke(host, p, ev, s) {
    host.textContent = "";
    var box = el("div", "dc-revert-box");
    box.appendChild(el("p", "step-hint",
      "Revoke the penalty if it was overturned. To correct an entry, tick the box and enter the corrected penalty: " +
      "the old one is revoked and the new one registered together. Nothing is deleted."));
    var reason = textInput("Reason (required)");
    box.appendChild(field("rv-reason-" + p.id, "Reason for the change", reason));

    var tick = document.createElement("input");
    tick.type = "checkbox";
    var tickLabel = el("label", "dc-radio");
    tickLabel.appendChild(tick);
    tickLabel.appendChild(document.createTextNode(" Replace it with a corrected penalty"));
    box.appendChild(tickLabel);

    var fixBox = el("div", "dc-sub");
    fixBox.hidden = true;
    var type = typeSelect();
    type.value = p.penalty_type;
    var places = numberInput("Places");
    places.value = p.places || "";
    var orig = numberInput("Optional");
    orig.value = p.original_position || "";
    var adj = numberInput("Optional");
    adj.value = p.adjusted_position || "";
    var newReason = textInput("Reason or official information (required)");
    var ref = textInput("Optional source");
    ref.value = p.reference || "";
    var placesField = field("rv-places-" + p.id, "Number of grid places", places);
    fixBox.appendChild(field("rv-type-" + p.id, "Corrected penalty", type));
    fixBox.appendChild(placesField);
    fixBox.appendChild(field("rv-orig-" + p.id, "Original start position", orig));
    fixBox.appendChild(field("rv-adj-" + p.id, "Adjusted start position", adj));
    fixBox.appendChild(field("rv-new-" + p.id, "Reason or official information for the corrected penalty", newReason));
    fixBox.appendChild(field("rv-ref-" + p.id, "Source", ref));
    box.appendChild(fixBox);

    function sync() {
      fixBox.hidden = !tick.checked;
      placesField.hidden = type.value !== "places";
    }
    tick.addEventListener("change", sync);
    type.addEventListener("change", sync);
    sync();

    var go = el("button", "btn btn-primary", "Confirm");
    go.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(go);
    box.appendChild(actions);
    host.appendChild(box);

    go.addEventListener("click", function () {
      if (state.busy) { return; }
      if (reason.value.trim().length < 3) { setMessage("error", "A reason of at least three characters is required."); return; }
      var replacement = null;
      if (tick.checked) {
        var problem = checkPenaltyFields(type.value, places.value, orig.value, adj.value, newReason.value);
        if (problem) { setMessage("error", problem); return; }
        replacement = {
          penalty_type: type.value,
          places: type.value === "places" ? intOrNull(places.value) : null,
          original_position: intOrNull(orig.value),
          adjusted_position: intOrNull(adj.value),
          reason: newReason.value.trim(),
          reference: ref.value.trim() || null
        };
      }
      var text = tick.checked ? "Revoke and replace this penalty?" : "Revoke this penalty?";
      if (!window.confirm(text + "\n\n" + ev.name + "\n\nPlayers with a saved prediction for this session will be notified.")) { return; }
      state.busy = true;
      go.disabled = true;
      setMessage("", "Saving...");
      client.rpc("admin_revoke_grid_penalty", {
        p_penalty_id: p.id, p_reason: reason.value.trim(), p_replacement: replacement
      }).then(function (res) {
        state.busy = false;
        if (res.error) { throw res.error; }
        var out = res.data || {};
        flushPush();
        setMessage("ok", (replacement ? "Penalty corrected. " : "Penalty revoked. ") + (out.notified || 0) +
          (out.notified === 1 ? " player was" : " players were") + " notified.");
        return loadHistory();
      }).catch(function (err) {
        state.busy = false;
        console.error(err);
        go.disabled = false;
        setMessage("error", errorText(err, "Could not change the penalty."));
      });
    });
  }

  // ---------- loading ----------

  function loadDriverList() {
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
    return client.from("grid_penalties")
      .select("id, entry_type, session_id, driver_id, penalty_type, places, original_position, adjusted_position, reason, reference, revokes_id, registered_by, registered_at")
      .order("registered_at", { ascending: false }).limit(60)
      .then(function (res) {
        if (res.error) { throw res.error; }
        var rows = res.data || [];
        if (rows.length === 0) { renderHistory([], {}, {}, {}); return; }
        var sessionIds = Array.from(new Set(rows.map(function (r) { return r.session_id; })));
        return client.from("sessions").select("id, event_id, session_type").in("id", sessionIds).then(function (sres) {
          if (sres.error) { throw sres.error; }
          var sessions = {};
          (sres.data || []).forEach(function (s) { sessions[s.id] = s; });
          var eventIds = Array.from(new Set((sres.data || []).map(function (s) { return s.event_id; })));
          var adminIds = Array.from(new Set(rows.map(function (r) { return r.registered_by; }).filter(function (x) { return !!x; })));
          return Promise.all([
            client.from("events").select("id, name").in("id", eventIds),
            adminIds.length ? client.from("profiles").select("id, display_name").in("id", adminIds) : Promise.resolve({ data: [] })
          ]).then(function (all) {
            if (all[0].error) { throw all[0].error; }
            var events = {};
            (all[0].data || []).forEach(function (e) { events[e.id] = e; });
            var names = {};
            ((all[1] && all[1].data) || []).forEach(function (p) { names[p.id] = p.display_name; });
            renderHistory(rows, events, sessions, names);
          });
        });
      });
  }

  function failure(err) {
    console.error(err);
    var text = (err && (err.message || "")) + " " + ((err && err.code) || "");
    setMessage("error", /does not exist|schema cache|PGRST20[0-9]|42P01/i.test(text)
      ? "Grid penalties need the latest database update (034_grid_penalties.sql)."
      : "Could not load grid penalties. Please reload the page.");
  }

  function loadAll() {
    return Promise.all([loadDriverList(), loadEvents()]).then(function () {
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
