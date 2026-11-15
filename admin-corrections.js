// Lights Out: Admin "Prediction corrections". Milestone M6.
// Correct one player's saved prediction after the session has locked (or replace a driver in several players' predictions in
// one operation). It is exceptional: it never reopens a session, the player's submission time stays untouched, and the
// original picks stay in the history. Everything is saved by the database functions admin_preview_corrections,
// admin_correct_predictions and admin_revert_correction (migration 037); this file never writes a table directly, and it never
// touches season picks, season bonus points or any other player's score.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var section = document.getElementById("corrections-admin");
  if (!section) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var els = {
    form: document.getElementById("corrections-form"),
    list: document.getElementById("corrections-list"),
    empty: document.getElementById("corrections-empty"),
    message: document.getElementById("corrections-message"),
    refresh: document.getElementById("corrections-refresh")
  };

  var SESSION_LABELS = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };
  var TYPE_ORDER = { sprint_qualifying: 1, sprint: 2, qualifying: 3, race: 4 };

  var state = { events: [], drivers: [], preview: null, related: { subs: [], pens: [] }, busy: false, ticket: 0 };
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

  function stamp(iso) {
    return new Date(iso).toLocaleString([], {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function errorText(err, fallback) {
    return (err && err.message) ? err.message : fallback;
  }

  function sessionName(t) { return SESSION_LABELS[t] || t; }

  function driverById(id) {
    for (var i = 0; i < state.drivers.length; i++) {
      if (state.drivers[i].id === id) { return state.drivers[i]; }
    }
    return null;
  }

  function code(id) {
    var d = driverById(id);
    return d ? d.code : String(id);
  }

  function driverLabel(d) {
    return d.code + " - " + d.full_name;
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

  // Ask the push function to deliver the new notices right away (otherwise the 15-minute schedule does). Best effort.
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

  // The driver slots of a picks object, in order: [{path, label, id}]. Counts and yes/no answers are not slots.
  function slotsOf(type, picks) {
    var slots = [];
    var sq = type === "sprint_qualifying";
    function arr(key, labelFn) {
      var list = picks[key];
      if (!Array.isArray(list)) { return; }
      list.forEach(function (id, i) { slots.push({ key: key, index: i, label: labelFn(i), id: id }); });
    }
    if (type === "qualifying" || sq) {
      arr("q1_out", function (i) { return "Out in " + (sq ? "SQ1" : "Q1") + " #" + (i + 1); });
      arr("q2_out", function (i) { return "Out in " + (sq ? "SQ2" : "Q2") + " #" + (i + 1); });
      arr("q3_order", function (i) { return (sq ? "SQ3" : "Q3") + " P" + (i + 1); });
    } else {
      arr("top8", function (i) { return "P" + (i + 1); });
      if (typeof picks.fastest_lap === "string") { slots.push({ key: "fastest_lap", index: null, label: "Fastest lap", id: picks.fastest_lap }); }
      arr("dnf_drivers", function (i) { return "DNF driver " + (i + 1); });
      if (typeof picks.dnf_driver === "string") { slots.push({ key: "dnf_driver", index: null, label: "DNF driver", id: picks.dnf_driver }); }
    }
    return slots;
  }

  function applySlots(picks, slots, values) {
    var out = JSON.parse(JSON.stringify(picks));
    slots.forEach(function (s, i) {
      if (s.index === null) { out[s.key] = values[i]; } else { out[s.key][s.index] = values[i]; }
    });
    return out;
  }

  function replaceDriver(picks, from, to) {
    var out = JSON.parse(JSON.stringify(picks));
    ["q1_out", "q2_out", "q3_order", "top8", "dnf_drivers"].forEach(function (key) {
      if (Array.isArray(out[key])) { out[key] = out[key].map(function (id) { return id === from ? to : id; }); }
    });
    if (out.fastest_lap === from) { out.fastest_lap = to; }
    if (out.dnf_driver === from) { out.dnf_driver = to; }
    return out;
  }

  function containsDriver(picks, id) {
    return JSON.stringify(picks).indexOf('"' + id + '"') !== -1;
  }

  function diffLines(type, oldPicks, newPicks) {
    var a = slotsOf(type, oldPicks);
    var b = slotsOf(type, newPicks);
    var lines = [];
    a.forEach(function (s, i) {
      if (b[i] && b[i].id !== s.id) { lines.push(s.label + ": " + code(s.id) + " \u2192 " + code(b[i].id)); }
    });
    return lines;
  }

  // ---------- selection ----------

  function buildForm() {
    els.form.textContent = "";
    var box = el("div", "dc-form");
    f.event = document.createElement("select");
    f.session = document.createElement("select");
    box.appendChild(field("cr-event", "1. Grand Prix", f.event));
    box.appendChild(field("cr-session", "2. Session", f.session));
    f.load = el("button", "btn btn-primary", "Show the saved predictions");
    f.load.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(f.load);
    box.appendChild(actions);
    f.work = el("div", "dc-preview");
    box.appendChild(f.work);
    els.form.appendChild(box);

    fillSelect(f.event, state.events.map(function (e) {
      return { value: e.id, label: "Round " + e.round + " - " + e.name + " (" + e.start_date + ")" };
    }), state.events.length ? "Choose a Grand Prix" : "No Grand Prix found");
    fillSelect(f.session, [], "Choose a Grand Prix first");

    f.event.addEventListener("change", function () { f.work.textContent = ""; loadSessions(); });
    f.session.addEventListener("change", function () { f.work.textContent = ""; });
    f.load.addEventListener("click", showPredictions);
  }

  function loadSessions() {
    var eventId = f.event.value;
    fillSelect(f.session, [], eventId ? "Loading..." : "Choose a Grand Prix first");
    if (!eventId) { return; }
    client.from("sessions").select("id, session_type, start_utc").eq("event_id", eventId).then(function (res) {
      if (res.error) { throw res.error; }
      if (f.event.value !== eventId) { return; }
      var rows = (res.data || []).sort(function (a, b) { return (TYPE_ORDER[a.session_type] || 9) - (TYPE_ORDER[b.session_type] || 9); });
      fillSelect(f.session, rows.map(function (s) { return { value: s.id, label: sessionName(s.session_type) }; }), "Choose a session");
    }).catch(function (err) {
      console.error(err);
      setMessage("error", errorText(err, "Could not load the sessions."));
    });
  }

  function showPredictions() {
    if (state.busy) { return; }
    if (!f.event.value || !f.session.value) { setMessage("error", "Choose the Grand Prix and the session."); return; }
    setMessage("", "");
    var ticket = ++state.ticket;
    var eventId = f.event.value;
    f.work.textContent = "";
    f.work.appendChild(el("p", "placeholder", "Loading..."));

    Promise.all([
      client.rpc("admin_preview_corrections", { p_session_id: f.session.value }),
      client.from("driver_substitutions").select("id, out_info, in_info, registered_at").eq("event_id", eventId).order("registered_at"),
      client.from("sessions").select("id").eq("event_id", eventId)
    ]).then(function (res) {
      if (ticket !== state.ticket) { return null; }
      if (res[0].error) { throw res[0].error; }
      state.preview = res[0].data;
      state.related.subs = res[1].data || [];
      var ids = (res[2].data || []).map(function (s) { return s.id; });
      return client.from("grid_penalties")
        .select("id, entry_type, driver_id, penalty_type, places, session_id, registered_at")
        .eq("entry_type", "penalty").in("session_id", ids).order("registered_at").then(function (p) {
          if (ticket !== state.ticket) { return; }
          state.related.pens = p.data || [];
          renderPredictions();
        });
    }).catch(function (err) {
      if (ticket !== state.ticket) { return; }
      console.error(err);
      f.work.textContent = "";
      setMessage("error", errorText(err, "Could not load the predictions."));
    });
  }

  function renderPredictions() {
    var data = state.preview;
    f.work.textContent = "";
    var title = data.event.name + " - " + sessionName(data.session.session_type);
    f.work.appendChild(el("h3", "dc-subtitle", "3. Saved predictions"));
    f.work.appendChild(el("p", "dc-summary", title));

    if (!data.eligible) {
      f.work.appendChild(el("p", "editor-message error",
        "Predictions are still open for this session, so players can still edit their own. A correction is only possible after they close."));
      return;
    }
    f.work.appendChild(el("p", "step-hint",
      (data.has_approved_result ? "This session has an approved result: the corrected player's score is recalculated (only theirs). "
        : "This session has no approved result yet: the corrected picks are scored when the result is approved. ") +
      "The player's submission time is never changed and his original picks are kept in the history."));

    var players = data.players || [];
    if (players.length === 0) {
      f.work.appendChild(el("p", "placeholder", "Nobody saved a prediction for this session."));
      return;
    }

    var holder = el("div", "");
    players.forEach(function (p) {
      var card = el("div", "dc-card");
      card.appendChild(el("strong", "", p.name || "A player"));
      card.appendChild(el("p", "dc-meta", "Saved " + stamp(p.created_at) + (p.updated_at !== p.created_at ? " \u00b7 last changed by the player " + stamp(p.updated_at) : "") +
        (p.points !== null && p.points !== undefined ? " \u00b7 " + p.points + " pts" : "")));
      if (p.latest_correction_id) {
        var chips = el("div", "dc-chips");
        chips.appendChild(el("span", "dc-chip is-on", "Corrected by an admin"));
        card.appendChild(chips);
      }
      var button = el("button", "btn btn-small", "Correct this prediction");
      button.type = "button";
      var host = el("div", "dc-revert");
      card.appendChild(button);
      card.appendChild(host);
      button.addEventListener("click", function () {
        if (host.firstChild) { host.textContent = ""; return; }
        openEditor(host, p);
      });
      holder.appendChild(card);
    });

    f.work.appendChild(buildBulk(players));
    f.work.appendChild(holder);
  }

  // ---------- confirm panel (shared) ----------

  function relatedOptions() {
    var opts = [];
    state.related.subs.forEach(function (s) {
      opts.push({ value: "sub:" + s.id, label: "Driver change: " + ((s.out_info && s.out_info.code) || "") + " \u2192 " + ((s.in_info && s.in_info.code) || "") + " (" + stamp(s.registered_at) + ")" });
    });
    state.related.pens.forEach(function (p) {
      opts.push({ value: "pen:" + p.id, label: "Grid penalty: " + code(p.driver_id) + " (" + (/-sprint$/.test(p.session_id) ? "Sprint" : "Race") + ")" });
    });
    return opts;
  }

  // items: [{user_id, picks}]. summary: lines shown before the reason.
  function confirmPanel(host, items, summary) {
    host.textContent = "";
    var box = el("div", "dc-revert-box");
    summary.forEach(function (line) { box.appendChild(el("p", "dc-log", line)); });

    var reason = textInput("Reason (required)");
    box.appendChild(field("cr-reason-" + Math.random().toString(36).slice(2, 8), "Reason for the correction", reason));
    var related = document.createElement("select");
    box.appendChild(field("cr-rel-" + Math.random().toString(36).slice(2, 8), "Related change (optional)", related));
    fillSelect(related, relatedOptions(), "None");

    var go = el("button", "btn btn-primary", "Confirm correction");
    go.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(go);
    box.appendChild(actions);
    host.appendChild(box);

    go.addEventListener("click", function () {
      if (state.busy) { return; }
      if (reason.value.trim().length < 3) { setMessage("error", "A reason of at least three characters is required."); return; }
      var ok = window.confirm("Correct " + items.length + (items.length === 1 ? " prediction" : " predictions") + "?\n\n" +
        state.preview.event.name + " - " + sessionName(state.preview.session.session_type) +
        "\n\nThe player's submission time is not changed. Each corrected player is notified, and only his score for this session is recalculated.");
      if (!ok) { return; }
      var sel = related.value;
      state.busy = true;
      go.disabled = true;
      setMessage("", "Saving...");
      client.rpc("admin_correct_predictions", {
        p_session_id: state.preview.session.id,
        p_items: items,
        p_reason: reason.value.trim(),
        p_related_substitution: sel.indexOf("sub:") === 0 ? sel.slice(4) : null,
        p_related_penalty: sel.indexOf("pen:") === 0 ? sel.slice(4) : null
      }).then(function (res) {
        state.busy = false;
        if (res.error) { throw res.error; }
        var out = res.data || {};
        flushPush();
        setMessage("ok", "Corrected " + (out.corrected || 0) + (out.corrected === 1 ? " prediction." : " predictions.") +
          " Scores recalculated for those players only.");
        return Promise.all([loadHistory()]).then(function () { showPredictions(); });
      }).catch(function (err) {
        state.busy = false;
        console.error(err);
        go.disabled = false;
        setMessage("error", errorText(err, "Could not correct the predictions."));
      });
    });
  }

  // ---------- one player ----------

  function openEditor(host, player) {
    host.textContent = "";
    var type = state.preview.session.session_type;
    var slots = slotsOf(type, player.picks);
    var lineup = (state.preview.lineup || []).map(driverById).filter(Boolean);

    var box = el("div", "dc-revert-box");
    box.appendChild(el("p", "step-hint",
      "Change the drivers that need correcting. Counts and yes/no answers are not edited here. The corrected picks are checked " +
      "exactly like a player's own save (current lineup, one driver once, a complete ranking in Qualifying)."));
    var grid = el("div", "editor-grid");
    var selects = slots.map(function (s, i) {
      var sel = document.createElement("select");
      var seen = {};
      lineup.forEach(function (d) {
        seen[d.id] = true;
        var opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = driverLabel(d);
        sel.appendChild(opt);
      });
      if (!seen[s.id]) {
        var cur = driverById(s.id);
        var opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = (cur ? driverLabel(cur) : s.id) + " [saved, not in the lineup]";
        sel.appendChild(opt);
      }
      sel.value = s.id;
      grid.appendChild(field("cr-slot-" + player.user_id + "-" + i, s.label, sel));
      return sel;
    });
    box.appendChild(grid);

    var review = el("button", "btn btn-primary", "Review the change");
    review.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(review);
    box.appendChild(actions);
    var panel = el("div", "");
    box.appendChild(panel);
    host.appendChild(box);

    review.addEventListener("click", function () {
      var values = selects.map(function (s) { return s.value; });
      var next = applySlots(player.picks, slots, values);
      var lines = diffLines(type, player.picks, next);
      if (lines.length === 0) { setMessage("error", "Nothing was changed."); return; }
      setMessage("", "");
      confirmPanel(panel, [{ user_id: player.user_id, picks: next }], ["Change for " + (player.name || "the player") + ":"].concat(lines));
    });
  }

  // ---------- several players: replace one driver by another ----------

  function buildBulk(players) {
    var type = state.preview.session.session_type;
    var lineupIds = state.preview.lineup || [];
    var present = {};
    players.forEach(function (p) {
      slotsOf(type, p.picks).forEach(function (s) { present[s.id] = true; });
    });

    var details = document.createElement("details");
    details.className = "dc-details";
    details.appendChild(el("summary", "", "Replace a driver in several players' predictions at once"));
    var box = el("div", "dc-revert-box");
    box.appendChild(el("p", "step-hint",
      "For example after a driver substitution: replace the withdrawn driver by his replacement wherever he appears. " +
      "Players whose prediction already contains the replacement are skipped. Each player gets his own log entry."));
    var from = document.createElement("select");
    var to = document.createElement("select");
    box.appendChild(field("cr-from", "Replace this driver", from));
    box.appendChild(field("cr-to", "With", to));
    fillSelect(from, Object.keys(present).map(function (id) {
      var d = driverById(id);
      return { value: id, label: (d ? driverLabel(d) : id) + (lineupIds.indexOf(id) === -1 ? " [not in the lineup]" : "") };
    }), "Choose the driver to replace");
    fillSelect(to, lineupIds.map(driverById).filter(Boolean).map(function (d) { return { value: d.id, label: driverLabel(d) }; }),
      "Choose the replacement");

    var list = el("div", "");
    box.appendChild(list);
    var panel = el("div", "");
    box.appendChild(panel);
    details.appendChild(box);

    function refresh() {
      list.textContent = "";
      panel.textContent = "";
      if (!from.value || !to.value || from.value === to.value) { return; }
      var rows = [];
      players.forEach(function (p) {
        if (!containsDriver(p.picks, from.value)) { return; }
        var skip = containsDriver(p.picks, to.value);
        rows.push({ player: p, skip: skip, next: skip ? null : replaceDriver(p.picks, from.value, to.value) });
      });
      if (rows.length === 0) { list.appendChild(el("p", "placeholder", "No saved prediction contains this driver.")); return; }
      var boxes = [];
      rows.forEach(function (r) {
        var label = el("label", "dc-radio");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !r.skip;
        cb.disabled = r.skip;
        boxes.push(cb);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + (r.player.name || "A player") +
          (r.skip ? " (skipped: already has " + code(to.value) + ")" : "")));
        list.appendChild(label);
        list.appendChild(document.createElement("br"));
      });
      var go = el("button", "btn btn-primary", "Review");
      go.type = "button";
      var actions = el("div", "actions");
      actions.appendChild(go);
      list.appendChild(actions);
      go.addEventListener("click", function () {
        var items = [];
        var lines = [];
        rows.forEach(function (r, i) {
          if (boxes[i].checked && !r.skip) {
            items.push({ user_id: r.player.user_id, picks: r.next });
            lines.push((r.player.name || "A player") + ": " + code(from.value) + " \u2192 " + code(to.value));
          }
        });
        if (items.length === 0) { setMessage("error", "Select at least one player."); return; }
        setMessage("", "");
        confirmPanel(panel, items, lines);
      });
    }
    from.addEventListener("change", refresh);
    to.addEventListener("change", refresh);
    return details;
  }

  // ---------- history and revert ----------

  function renderHistory(rows, names, sessions, events) {
    els.list.textContent = "";
    els.empty.hidden = rows.length > 0;
    var reverted = {};
    rows.forEach(function (r) { if (r.action === "revert") { reverted[r.reverts_id] = true; } });
    var latestActive = {};
    rows.forEach(function (r) {
      if (r.action === "correct" && !reverted[r.id]) {
        var cur = latestActive[r.prediction_id];
        if (!cur || r.created_at > cur.created_at) { latestActive[r.prediction_id] = r; }
      }
    });

    rows.forEach(function (r) {
      var s = sessions[r.session_id] || {};
      var ev = events[s.event_id] || { name: s.event_id || "" };
      var card = el("div", "dc-card");
      card.appendChild(el("strong", "", ev.name + " - " + sessionName(s.session_type) + ": " + (names[r.user_id] || "a player") +
        (r.action === "revert" ? " (revert)" : "")));
      card.appendChild(el("p", "dc-meta", (r.action === "revert" ? "Reverted" : "Corrected") + " " + stamp(r.created_at) + " by " +
        (names[r.admin_id] || "an administrator") + " \u00b7 " + r.reason));
      var pts = r.points_before === null && r.points_after === null ? "No approved result yet"
        : "Score: " + (r.points_before === null ? "-" : r.points_before) + " \u2192 " + (r.points_after === null ? "-" : r.points_after);
      card.appendChild(el("p", "dc-meta", pts + " \u00b7 Player's own submission: " + stamp(r.original_created_at)));

      var chips = el("div", "dc-chips");
      if (r.action === "correct") {
        chips.appendChild(el("span", "dc-chip " + (reverted[r.id] ? "is-off" : "is-on"), reverted[r.id] ? "Reverted" : "In force"));
      }
      card.appendChild(chips);

      var detail = document.createElement("details");
      detail.className = "dc-details";
      detail.appendChild(el("summary", "", "Picks before and after"));
      var type = s.session_type || "race";
      detail.appendChild(el("p", "dc-log", "Before: " + summarise(type, r.before_picks)));
      detail.appendChild(el("p", "dc-log", "After: " + summarise(type, r.after_picks)));
      card.appendChild(detail);

      if (r.action === "correct" && latestActive[r.prediction_id] && latestActive[r.prediction_id].id === r.id) {
        var button = el("button", "btn btn-small", "Revert");
        button.type = "button";
        var host = el("div", "dc-revert");
        card.appendChild(button);
        card.appendChild(host);
        button.addEventListener("click", function () {
          if (host.firstChild) { host.textContent = ""; return; }
          openRevert(host, r);
        });
      }
      els.list.appendChild(card);
    });
  }

  function summarise(type, picks) {
    function ids(list) { return (list || []).map(code).join(", "); }
    if (!picks) { return ""; }
    if (type === "qualifying" || type === "sprint_qualifying") {
      return "Out first: " + ids(picks.q1_out) + ". Out second: " + ids(picks.q2_out) + ". Final order: " + ids(picks.q3_order) + ".";
    }
    var parts = ["Top 8: " + ids(picks.top8)];
    if (picks.fastest_lap) { parts.push("Fastest lap: " + code(picks.fastest_lap)); }
    if (picks.dnf_drivers && picks.dnf_drivers.length) { parts.push("DNF: " + ids(picks.dnf_drivers)); }
    return parts.join(". ") + ".";
  }

  function openRevert(host, row) {
    host.textContent = "";
    var box = el("div", "dc-revert-box");
    box.appendChild(el("p", "step-hint",
      "Restores the picks from before this correction and recalculates only this player's score. Nothing is deleted: the revert is " +
      "added to the history. Only the latest correction still in force can be reverted."));
    var reason = textInput("Reason (required)");
    box.appendChild(field("cr-rv-" + row.id, "Reason", reason));
    var go = el("button", "btn btn-primary", "Confirm revert");
    go.type = "button";
    var actions = el("div", "actions");
    actions.appendChild(go);
    box.appendChild(actions);
    host.appendChild(box);
    go.addEventListener("click", function () {
      if (state.busy) { return; }
      if (reason.value.trim().length < 3) { setMessage("error", "A reason of at least three characters is required."); return; }
      if (!window.confirm("Revert this correction?\n\nThe player is notified and his score for this session is recalculated.")) { return; }
      state.busy = true;
      go.disabled = true;
      setMessage("", "Saving...");
      client.rpc("admin_revert_correction", { p_correction_id: row.id, p_reason: reason.value.trim() }).then(function (res) {
        state.busy = false;
        if (res.error) { throw res.error; }
        flushPush();
        setMessage("ok", "Correction reverted. The player's score for this session was recalculated.");
        return loadHistory().then(function () { if (state.preview) { showPredictions(); } });
      }).catch(function (err) {
        state.busy = false;
        console.error(err);
        go.disabled = false;
        setMessage("error", errorText(err, "Could not revert the correction."));
      });
    });
  }

  // ---------- loading ----------

  function loadDrivers() {
    return client.from("drivers").select("id, season, code, full_name, team_name, is_active").order("code").then(function (res) {
      if (res.error) { throw res.error; }
      state.drivers = res.data || [];
    });
  }

  function loadEvents() {
    var soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    return client.from("events").select("id, name, season, round, status, start_date")
      .lte("start_date", soon).order("start_date", { ascending: false }).limit(15).then(function (res) {
        if (res.error) { throw res.error; }
        state.events = res.data || [];
      });
  }

  function loadHistory() {
    return client.from("prediction_corrections")
      .select("id, action, prediction_id, user_id, session_id, before_picks, after_picks, original_created_at, reason, admin_id, created_at, reverts_id, points_before, points_after")
      .order("created_at", { ascending: false }).limit(40).then(function (res) {
        if (res.error) { throw res.error; }
        var rows = res.data || [];
        if (rows.length === 0) { renderHistory([], {}, {}, {}); return; }
        var sessionIds = Array.from(new Set(rows.map(function (r) { return r.session_id; })));
        var peopleIds = Array.from(new Set(rows.map(function (r) { return r.user_id; }).concat(rows.map(function (r) { return r.admin_id; }))));
        return Promise.all([
          client.from("sessions").select("id, event_id, session_type").in("id", sessionIds),
          client.from("profiles").select("id, display_name").in("id", peopleIds)
        ]).then(function (all) {
          if (all[0].error) { throw all[0].error; }
          var sessions = {};
          (all[0].data || []).forEach(function (s) { sessions[s.id] = s; });
          var names = {};
          ((all[1] && all[1].data) || []).forEach(function (p) { names[p.id] = p.display_name; });
          var eventIds = Array.from(new Set((all[0].data || []).map(function (s) { return s.event_id; })));
          return client.from("events").select("id, name").in("id", eventIds).then(function (er) {
            var events = {};
            ((er && er.data) || []).forEach(function (e) { events[e.id] = e; });
            renderHistory(rows, names, sessions, events);
          });
        });
      });
  }

  function failure(err) {
    console.error(err);
    var text = (err && (err.message || "")) + " " + ((err && err.code) || "");
    setMessage("error", /does not exist|schema cache|PGRST20[0-9]|42P01/i.test(text)
      ? "Prediction corrections need the latest database update (037_prediction_corrections.sql)."
      : "Could not load prediction corrections. Please reload the page.");
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
    state.preview = null;
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
