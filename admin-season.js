// Lights Out: "Season results" section of the admin panel.
// Enter the official final standings of a season, review the points preview, approve or reject,
// and change a player's season picks with a logged reason.
// It is a separate script: admin.js and its result approval stay untouched.
// Database: migrations 025, 026 and 027.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var host = document.getElementById("season-admin");
  if (!host) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var listEl = document.getElementById("season-list");
  var emptyEl = document.getElementById("season-empty");
  var refreshBtn = document.getElementById("season-refresh");
  var msgEl = document.getElementById("season-message");

  var state = { driversById: {}, driversBySeason: {}, busy: false, seq: 0 };

  // ---------- Helpers ----------

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function badge(text, kind) { return el("span", "badge" + (kind ? " " + kind : ""), text); }

  function setMessage(kind, text) {
    msgEl.className = "message" + (kind ? " " + kind : "");
    msgEl.textContent = text || "";
  }

  function localTime(iso) {
    return new Date(iso).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function driverLabel(id) {
    var d = state.driversById[id];
    return d ? d.code + " - " + d.full_name : String(id);
  }

  function driverCode(id) {
    var d = state.driversById[id];
    return d ? d.code : String(id);
  }

  function teamsOf(season, activeOnly) {
    var seen = {};
    (state.driversBySeason[season] || []).forEach(function (d) {
      if (!activeOnly || d.is_active) { seen[d.team_name] = true; }
    });
    return Object.keys(seen).sort();
  }

  function option(value, label) {
    var o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function field(labelText, control) {
    var wrap = el("div", "field");
    var id = "ss" + (++state.seq);
    var label = el("label", "", labelText);
    label.setAttribute("for", id);
    control.id = id;
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  // Disable an option in the other selects when it is already chosen in one of them.
  function keepDistinct(selects) {
    function sync() {
      var chosen = selects.map(function (s) { return s.value; });
      selects.forEach(function (s) {
        Array.prototype.forEach.call(s.options, function (o) {
          o.disabled = o.value !== "" && o.value !== s.value && chosen.indexOf(o.value) !== -1;
        });
      });
    }
    selects.forEach(function (s) { s.addEventListener("change", sync); });
    sync();
  }

  function resultBlock(drivers, teams) {
    var wrap = el("div", "result-data");
    var b1 = el("div", "result-block");
    b1.appendChild(el("h4", "", "Drivers' championship"));
    var ol1 = el("ol", "result-list");
    drivers.forEach(function (id) { ol1.appendChild(el("li", "", driverLabel(id))); });
    b1.appendChild(ol1);
    var b2 = el("div", "result-block");
    b2.appendChild(el("h4", "", "Constructors' championship"));
    var ol2 = el("ol", "result-list");
    teams.forEach(function (t) { ol2.appendChild(el("li", "", t)); });
    b2.appendChild(ol2);
    wrap.appendChild(b1);
    wrap.appendChild(b2);
    return wrap;
  }

  function setBusy(on) {
    state.busy = on;
    Array.prototype.forEach.call(listEl.querySelectorAll("button"), function (b) {
      if (on) { b.setAttribute("data-was-disabled", b.disabled ? "1" : "0"); b.disabled = true; }
      else { b.disabled = b.getAttribute("data-was-disabled") === "1"; b.removeAttribute("data-was-disabled"); }
    });
    refreshBtn.disabled = on;
  }

  function run(rpcName, args, confirmText, doneText) {
    if (state.busy) { return; }
    if (confirmText && !window.confirm(confirmText)) { return; }
    setBusy(true);
    setMessage("", "Working...");
    client.rpc(rpcName, args).then(function (res) {
      if (res.error) {
        setBusy(false);
        setMessage("error", res.error.message);
        return;
      }
      setMessage("ok", doneText);
      return load(true);
    }).catch(function (err) {
      console.error(err);
      setBusy(false);
      setMessage("error", "Something went wrong. Please try again.");
    });
  }

  // ---------- Result editor ----------

  function openResultEditor(box, item, initial) {
    box.textContent = "";
    var season = item.season;
    var list = (state.driversBySeason[season] || []).slice().sort(function (a, b) { return a.code < b.code ? -1 : 1; });
    var teams = teamsOf(season, false);
    if (list.length === 0) {
      box.appendChild(el("p", "editor-message error", "No drivers are loaded for this season."));
      return;
    }

    var ed = el("div", "editor");
    ed.appendChild(el("h4", "", "Final standings for " + season + " (saved as a new pending version)"));
    var grid = el("div", "editor-grid");
    var colD = el("div");
    var colT = el("div");
    var dSel = [];
    var tSel = [];
    var places = ["Champion", "2nd", "3rd"];

    places.forEach(function (place, i) {
      var s = document.createElement("select");
      s.appendChild(option("", "Choose a driver"));
      list.forEach(function (d) { s.appendChild(option(d.id, d.code + " - " + d.full_name + " (" + d.team_name + ")")); });
      if (initial && initial.drivers && initial.drivers[i]) { s.value = initial.drivers[i]; }
      dSel.push(s);
      colD.appendChild(field("Drivers' " + place, s));
    });
    places.forEach(function (place, i) {
      var s = document.createElement("select");
      s.appendChild(option("", "Choose a team"));
      teams.forEach(function (t) { s.appendChild(option(t, t)); });
      if (initial && initial.teams && initial.teams[i]) { s.value = initial.teams[i]; }
      tSel.push(s);
      colT.appendChild(field("Constructors' " + place, s));
    });
    keepDistinct(dSel);
    keepDistinct(tSel);
    grid.appendChild(colD);
    grid.appendChild(colT);
    ed.appendChild(grid);

    var msg = el("p", "editor-message", "");
    var actions = el("div", "actions");
    var save = el("button", "btn btn-primary", "Save as new pending version");
    save.type = "button";
    var cancel = el("button", "btn", "Cancel");
    cancel.type = "button";
    actions.appendChild(save);
    actions.appendChild(cancel);
    ed.appendChild(actions);
    ed.appendChild(msg);
    box.appendChild(ed);

    cancel.addEventListener("click", function () { box.textContent = ""; });
    save.addEventListener("click", function () {
      var drivers = dSel.map(function (s) { return s.value; });
      var tms = tSel.map(function (s) { return s.value; });
      if (drivers.indexOf("") !== -1 || tms.indexOf("") !== -1) {
        msg.className = "editor-message error";
        msg.textContent = "Choose all three drivers and all three teams.";
        return;
      }
      if (state.busy) { return; }
      state.busy = true;
      save.disabled = true;
      msg.className = "editor-message";
      msg.textContent = "Saving...";
      client.rpc("admin_save_season_result", { p_season: season, p_drivers: drivers, p_teams: tms }).then(function (res) {
        state.busy = false;
        if (res.error) {
          save.disabled = false;
          msg.className = "editor-message error";
          msg.textContent = res.error.message;
          return;
        }
        setMessage("ok", "Saved as a new pending version. Check the points preview below, then approve it.");
        return load(true);
      }).catch(function (err) {
        state.busy = false;
        save.disabled = false;
        console.error(err);
        msg.className = "editor-message error";
        msg.textContent = "Something went wrong. Please try again.";
      });
    });
  }

  // ---------- Pick override ----------

  function overrideForm(item, players) {
    var details = document.createElement("details");
    details.appendChild(el("summary", "", "Change a player's season picks"));
    var ed = el("div", "editor");
    ed.appendChild(el("p", "step-hint", "Use this when a player could not pick in time or made a mistake. Your reason is saved in the log. If the result is already approved, the points update straight away."));

    var drivers = (state.driversBySeason[item.season] || []).filter(function (d) { return d.is_active; })
      .sort(function (a, b) { return a.code < b.code ? -1 : 1; });
    var teams = teamsOf(item.season, true);
    if (drivers.length === 0) {
      ed.appendChild(el("p", "editor-message error", "No active drivers are loaded for this season."));
      details.appendChild(ed);
      return details;
    }

    var pSel = document.createElement("select");
    pSel.appendChild(option("", "Choose a player"));
    players.forEach(function (p) { pSel.appendChild(option(p.user_id, p.name)); });
    var dSel = document.createElement("select");
    dSel.appendChild(option("", "Choose a driver"));
    drivers.forEach(function (d) { dSel.appendChild(option(d.id, d.code + " - " + d.full_name + " (" + d.team_name + ")")); });
    var tSel = document.createElement("select");
    tSel.appendChild(option("", "Choose a team"));
    teams.forEach(function (t) { tSel.appendChild(option(t, t)); });
    var reason = document.createElement("input");
    reason.type = "text";
    reason.maxLength = 200;
    reason.placeholder = "For example: missed the deadline, agreed in the group chat";

    pSel.addEventListener("change", function () {
      var cur = null;
      (item.picks || []).forEach(function (pk) { if (pk.user_id === pSel.value) { cur = pk; } });
      dSel.value = cur ? cur.drivers_pick : "";
      tSel.value = cur ? cur.constructors_pick : "";
    });

    var grid = el("div", "editor-grid");
    var c1 = el("div");
    var c2 = el("div");
    c1.appendChild(field("Player", pSel));
    c1.appendChild(field("Reason (required)", reason));
    c2.appendChild(field("Drivers' champion pick", dSel));
    c2.appendChild(field("Constructors' champion pick", tSel));
    grid.appendChild(c1);
    grid.appendChild(c2);
    ed.appendChild(grid);

    var msg = el("p", "editor-message", "");
    var actions = el("div", "actions");
    var save = el("button", "btn btn-primary", "Save change");
    save.type = "button";
    actions.appendChild(save);
    ed.appendChild(actions);
    ed.appendChild(msg);
    details.appendChild(ed);

    save.addEventListener("click", function () {
      if (!pSel.value || !dSel.value || !tSel.value) {
        msg.className = "editor-message error";
        msg.textContent = "Choose a player, a driver and a team.";
        return;
      }
      if (reason.value.trim().length < 3) {
        msg.className = "editor-message error";
        msg.textContent = "Write a short reason (at least 3 characters).";
        return;
      }
      var who = pSel.options[pSel.selectedIndex].textContent;
      run("admin_set_season_prediction",
        { p_user: pSel.value, p_season: item.season, p_driver: dSel.value, p_team: tSel.value, p_reason: reason.value.trim() },
        "Set " + who + "'s " + item.season + " picks to " + driverCode(dSel.value) + " and " + tSel.value + "?\nThis is saved in the log with your reason.",
        "Picks changed for " + who + ".");
    });
    return details;
  }

  // ---------- Rendering ----------

  function logSection(item, logRows, names) {
    var rows = logRows.filter(function (r) { return r.season === item.season; });
    var details = document.createElement("details");
    details.appendChild(el("summary", "", "Pick changes by admins (" + rows.length + ")"));
    if (rows.length === 0) {
      details.appendChild(el("p", "step-hint", "No changes yet."));
      return details;
    }
    var ul = el("ul", "plain-list");
    rows.forEach(function (r) {
      var from = r.old_pick ? driverCode(r.old_pick.drivers_pick) + ", " + r.old_pick.constructors_pick + " \u2192 " : "";
      var to = driverCode(r.new_pick.drivers_pick) + ", " + r.new_pick.constructors_pick;
      ul.appendChild(el("li", "", localTime(r.created_at) + " \u00b7 " + (names[r.admin_id] || "An admin") + " set " +
        (names[r.user_id] || "a player") + ": " + from + to + " \u00b7 \u201c" + r.reason + "\u201d"));
    });
    details.appendChild(ul);
    return details;
  }

  function renderSeason(item, logRows) {
    var card = el("section", "panel admin-card");
    card.appendChild(el("h3", "", item.season + " season"));

    var missing = item.missing || [];
    var picks = item.picks || [];
    var names = {};
    picks.forEach(function (p) { names[p.user_id] = p.name; });
    missing.forEach(function (p) { names[p.user_id] = p.name; });
    var players = picks.concat(missing).sort(function (a, b) { return a.name < b.name ? -1 : 1; });

    var badges = el("div", "badges");
    badges.appendChild(badge(item.picks_count + " of " + (item.picks_count + missing.length) + " players have picks"));
    if (item.lock_at === null || item.lock_at === undefined) {
      badges.appendChild(badge("Lock time not confirmed: approval is blocked", "bad"));
    } else if (item.closed) {
      badges.appendChild(badge("Picks closed", "ok"));
    } else {
      badges.appendChild(badge("Picks still open: approval is blocked", "bad"));
    }
    card.appendChild(badges);
    if (item.lock_at) {
      card.appendChild(el("p", "step-hint", "Main lock " + localTime(item.lock_at) +
        (item.late_lock_at ? " \u00b7 late entry until " + localTime(item.late_lock_at) : "")));
    }

    if (item.approved) {
      card.appendChild(el("h4", "ss-sub", "Approved result (version " + item.approved.version + ")"));
      card.appendChild(resultBlock(item.approved.drivers, item.approved.teams));
      card.appendChild(el("p", "step-hint", "Approved " + localTime(item.approved.approved_at) +
        (item.approved.approved_by_name ? " by " + item.approved.approved_by_name : "")));
    }

    var editorHost = document.createElement("div");

    if (item.pending) {
      card.appendChild(el("h4", "ss-sub", "Pending result (version " + item.pending.version + ")"));
      if (item.approved) { card.appendChild(badge("Replaces approved version " + item.approved.version, "warn")); }
      card.appendChild(resultBlock(item.pending.drivers, item.pending.teams));
      card.appendChild(el("p", "step-hint", "Entered " + localTime(item.pending.entered_at)));

      var preview = item.pending.preview || [];
      var pbox = document.createElement("details");
      pbox.open = preview.length > 0;
      pbox.appendChild(el("summary", "", "Points preview if approved (" + preview.length + " player(s))"));
      if (preview.length === 0) {
        pbox.appendChild(el("p", "step-hint", "Nobody has season picks."));
      } else {
        var table = el("table", "preview-table");
        preview.forEach(function (row) {
          var tr = document.createElement("tr");
          tr.appendChild(el("td", "", row.name));
          tr.appendChild(el("td", "num", row.points + " pts"));
          table.appendChild(tr);
        });
        pbox.appendChild(table);
      }
      card.appendChild(pbox);

      var actions = el("div", "actions");
      var approve = el("button", "btn btn-primary", "Approve");
      approve.type = "button";
      approve.disabled = !item.closed;
      approve.addEventListener("click", function () {
        run("admin_approve_season_result", { p_result_id: item.pending.id },
          "Approve this " + item.season + " season result?\nSeason points will be calculated for every player's picks.",
          "Approved. Season points were calculated.");
      });
      var edit = el("button", "btn", "Edit");
      edit.type = "button";
      edit.addEventListener("click", function () { openResultEditor(editorHost, item, item.pending); });
      var reject = el("button", "btn btn-danger", "Reject");
      reject.type = "button";
      reject.addEventListener("click", function () {
        run("admin_reject_season_result", { p_result_id: item.pending.id },
          "Reject this pending " + item.season + " season result?\nIt will be discarded and will not count.",
          "Rejected.");
      });
      actions.appendChild(approve);
      actions.appendChild(edit);
      actions.appendChild(reject);
      card.appendChild(actions);
      if (!item.closed) {
        card.appendChild(el("p", "step-hint", "Approval opens once the main lock and the late entry window have passed."));
      }
    } else {
      var actions2 = el("div", "actions");
      var enter = el("button", "btn btn-primary", item.approved ? "Enter a correction" : "Enter the final standings");
      enter.type = "button";
      enter.addEventListener("click", function () { openResultEditor(editorHost, item, item.approved || null); });
      actions2.appendChild(enter);
      card.appendChild(actions2);
    }
    card.appendChild(editorHost);

    var pbox2 = document.createElement("details");
    pbox2.open = true;
    pbox2.appendChild(el("summary", "", "Players' picks (" + picks.length + ")"));
    if (picks.length > 0) {
      var t2 = el("table", "preview-table");
      picks.forEach(function (p) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", "", p.name + (p.half_value ? " (half value)" : "")));
        tr.appendChild(el("td", "", driverCode(p.drivers_pick) + " \u00b7 " + p.constructors_pick));
        tr.appendChild(el("td", "num", p.points === null || p.points === undefined ? "" : p.points + " pts"));
        t2.appendChild(tr);
      });
      pbox2.appendChild(t2);
    }
    if (missing.length > 0) {
      pbox2.appendChild(el("p", "step-hint", "No picks: " + missing.map(function (m) { return m.name; }).join(", ")));
    }
    card.appendChild(pbox2);

    card.appendChild(overrideForm(item, players));
    card.appendChild(logSection(item, logRows, names));
    return card;
  }

  function render(overview, logRows) {
    listEl.textContent = "";
    emptyEl.hidden = overview.length > 0;
    overview.forEach(function (item) { listEl.appendChild(renderSeason(item, logRows)); });
  }

  // ---------- Loading ----------

  function load(keepMessage) {
    if (!keepMessage) { setMessage("", ""); }
    return Promise.all([
      client.from("drivers").select("id, season, code, full_name, team_name, is_active").order("code"),
      client.rpc("admin_season_overview"),
      client.from("season_prediction_log").select("created_at, season, user_id, admin_id, old_pick, new_pick, reason")
        .order("created_at", { ascending: false }).limit(100)
    ]).then(function (res) {
      state.busy = false;
      refreshBtn.disabled = false;
      var err = res[0].error || res[1].error || res[2].error;
      if (err) {
        console.error(err);
        var text = (err.message || "") + " " + (err.code || "");
        setMessage("error", /does not exist|schema cache|PGRST20[0-9]|42P01|42883/i.test(text)
          ? "Season admin needs the latest database updates (026_season_results_scoring.sql and 027_admin_season_overview_missing.sql)."
          : err.message || "Could not load season results.");
        return;
      }
      state.driversById = {};
      state.driversBySeason = {};
      (res[0].data || []).forEach(function (d) {
        state.driversById[d.id] = d;
        (state.driversBySeason[d.season] = state.driversBySeason[d.season] || []).push(d);
      });
      render(res[1].data || [], res[2].data || []);
    }).catch(function (err) {
      state.busy = false;
      refreshBtn.disabled = false;
      console.error(err);
      setMessage("error", "Could not load season results. Please try again.");
    });
  }

  refreshBtn.addEventListener("click", function () { if (!state.busy) { load(false); } });

  // Show the section only to admins (the database checks again on every call).
  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) { return; }
    return client.rpc("is_admin").then(function (res) {
      if (res.error || res.data !== true) { return; }
      host.hidden = false;
      return load(false);
    });
  }).catch(function (err) { console.error(err); });
})();