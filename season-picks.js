// Lights Out: season picks card on the Predictions page (Drivers' champion and Constructors' champion).
// Reads season_prediction_windows, drivers and season_predictions; saves through the database function
// submit_season_prediction (migration 025). It never touches the session prediction form.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var card = document.getElementById("season-card");
  if (!card) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var els = {
    sub: document.getElementById("sp-sub"),
    state: document.getElementById("sp-state"),
    body: document.getElementById("sp-body")
  };

  // Same approximate team colours as predict-tiles.js (keep the two lists in step).
  var TEAM_COLORS = [
    ["mercedes", "#27f4d2"], ["ferrari", "#e8002d"], ["mclaren", "#ff8000"], ["red bull", "#3671c6"],
    ["haas", "#b6babd"], ["rb f1", "#6692ff"], ["racing bulls", "#6692ff"], ["audi", "#8e949c"],
    ["alpine", "#0093cc"], ["williams", "#64c4ff"], ["cadillac", "#d0d4da"], ["aston", "#229971"]
  ];

  var state = { user: null, token: 0, closeMs: null, notice: null };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function teamColor(name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < TEAM_COLORS.length; i++) {
      if (lower.indexOf(TEAM_COLORS[i][0]) !== -1) { return TEAM_COLORS[i][1]; }
    }
    return "#7a7f87";
  }

  function lastName(full) {
    var parts = String(full).trim().split(/\s+/);
    return parts[parts.length - 1];
  }

  function whenText(ms) {
    return new Date(ms).toLocaleString([], {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function setFlag(kind, text) {
    els.state.setAttribute("data-kind", kind || "");
    els.state.textContent = text || "";
  }

  // Hide the card, unless there is something to tell the player (for example: the picks just closed).
  function hideCard(notice) {
    state.closeMs = null;
    if (notice) {
      els.sub.textContent = "";
      els.body.textContent = "";
      setFlag("closed", notice);
      card.hidden = false;
      return;
    }
    card.hidden = true;
  }

  // ---------- Chips ----------

  function driverChip(d, readonly) {
    var chip = el(readonly ? "div" : "button", "dchip");
    if (!readonly) { chip.type = "button"; chip.setAttribute("aria-pressed", "false"); chip.setAttribute("data-id", d.id); }
    chip.style.setProperty("--team", teamColor(d.team_name));
    chip.appendChild(el("span", "dc-code", d.code));
    chip.appendChild(el("span", "dc-num", d.car_number ? String(d.car_number) : ""));
    chip.appendChild(el("span", "dc-name", lastName(d.full_name) + " \u00b7 " + d.team_name));
    return chip;
  }

  function teamChip(team, codes, readonly) {
    var chip = el(readonly ? "div" : "button", "dchip");
    if (!readonly) { chip.type = "button"; chip.setAttribute("aria-pressed", "false"); chip.setAttribute("data-team", team); }
    chip.style.setProperty("--team", teamColor(team));
    chip.appendChild(el("span", "dc-code", team));
    chip.appendChild(el("span", "dc-name", codes.join(" \u00b7 ")));
    return chip;
  }

  function sortedDrivers(drivers) {
    return drivers.slice().sort(function (a, b) {
      if (a.team_name !== b.team_name) { return a.team_name < b.team_name ? -1 : 1; }
      return (a.car_number || 0) - (b.car_number || 0);
    });
  }

  function teamsOf(drivers) {
    var map = {};
    sortedDrivers(drivers).forEach(function (d) { (map[d.team_name] = map[d.team_name] || []).push(d.code); });
    return Object.keys(map).sort().map(function (name) { return { name: name, codes: map[name] }; });
  }

  function step(title, hint) {
    var wrap = el("div", "form-step");
    wrap.appendChild(el("h3", "", title));
    wrap.appendChild(el("p", "step-hint", hint));
    return wrap;
  }

  // ---------- States ----------

  function renderWaiting(win) {
    els.sub.textContent = win.season + " champions";
    setFlag("waiting", "Season picks open once the " + win.season + " drivers and the Round 1 session times are confirmed.");
    els.body.textContent = "";
    card.hidden = false;
  }

  function renderClosed(win, drivers, mine) {
    els.sub.textContent = win.season + " champions";
    var lockMs = Date.parse(win.lock_at);
    var lateNote = mine.half_value ? " Picked after the main lock, so these count for half points." : "";
    setFlag("closed", "Season picks locked " + whenText(win.late_lock_at && mine.half_value ? Date.parse(win.late_lock_at) : lockMs) + "." + lateNote);

    els.body.textContent = "";
    var body = el("div", "sp-inner");
    var drv = null;
    drivers.forEach(function (d) { if (d.id === mine.drivers_pick) { drv = d; } });
    var codes = [];
    drivers.forEach(function (d) { if (d.team_name === mine.constructors_pick) { codes.push(d.code); } });

    var summary = el("div", "sp-summary");
    summary.appendChild(drv ? driverChip(drv, true) : el("p", "placeholder", "Driver: " + mine.drivers_pick));
    summary.appendChild(teamChip(mine.constructors_pick, codes, true));
    body.appendChild(el("p", "step-hint", "Your picks for the Drivers' and Constructors' champions."));
    body.appendChild(summary);
    els.body.appendChild(body);
    card.hidden = false;
  }

  function renderForm(win, mode, drivers, mine) {
    var lockMs = Date.parse(win.lock_at);
    var lateMs = win.late_lock_at ? Date.parse(win.late_lock_at) : null;
    var late = mode === "late";
    state.closeMs = late ? lateMs : lockMs;

    els.sub.textContent = win.season + " champions";
    setFlag("open", late
      ? "Late entry open until " + whenText(lateMs) + " (your local time). Your points count for half."
      : "Locks " + whenText(lockMs) + " (your local time). You can change your picks until then.");

    var sel = { driver: mine ? mine.drivers_pick : null, team: mine ? mine.constructors_pick : null };
    var saved = mine ? { driver: mine.drivers_pick, team: mine.constructors_pick } : null;

    els.body.textContent = "";
    var body = el("div", "sp-inner");

    body.appendChild(el("p", "points-note",
      "Points come after the season, once the official final standings are approved. Drivers' champion: 60 if your pick wins, " +
      "20 for 2nd, 10 for 3rd. Constructors' champion: 40, 15, 8. Both champions right: +10. " +
      (late ? "Picks made after the main lock count for half." : "Anyone who joins after the lock can still pick until Round 5 for half points.")));

    var s1 = step("Drivers' champion", "Who wins the drivers' title?");
    var grid1 = el("div", "chip-grid");
    grid1.setAttribute("role", "group");
    grid1.setAttribute("aria-label", "Drivers' champion");
    sortedDrivers(drivers).forEach(function (d) { grid1.appendChild(driverChip(d, false)); });
    s1.appendChild(grid1);

    var s2 = step("Constructors' champion", "Which team wins the constructors' title?");
    var grid2 = el("div", "chip-grid sp-teams");
    grid2.setAttribute("role", "group");
    grid2.setAttribute("aria-label", "Constructors' champion");
    teamsOf(drivers).forEach(function (t) { grid2.appendChild(teamChip(t.name, t.codes, false)); });
    s2.appendChild(grid2);

    var actions = el("div", "sp-actions");
    var status = el("p", "pick-status", "");
    status.setAttribute("role", "status");
    var save = el("button", "btn btn-primary", "Save season picks");
    save.type = "button";
    actions.appendChild(status);
    actions.appendChild(save);

    var msg = el("p", "message", "");
    msg.setAttribute("role", "status");
    msg.setAttribute("aria-live", "polite");

    body.appendChild(s1);
    body.appendChild(s2);
    body.appendChild(actions);
    body.appendChild(msg);
    els.body.appendChild(body);

    function setMessage(kind, text) {
      msg.className = "message" + (kind ? " " + kind : "");
      msg.textContent = text || "";
    }

    function refresh() {
      Array.prototype.forEach.call(grid1.children, function (chip) {
        var on = chip.getAttribute("data-id") === sel.driver;
        chip.classList.toggle("is-selected", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      });
      Array.prototype.forEach.call(grid2.children, function (chip) {
        var on = chip.getAttribute("data-team") === sel.team;
        chip.classList.toggle("is-selected", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      });

      var complete = !!(sel.driver && sel.team);
      var same = !!saved && saved.driver === sel.driver && saved.team === sel.team;
      if (!sel.driver && !sel.team) { status.textContent = "Pick a driver and a team"; status.setAttribute("data-kind", ""); }
      else if (!sel.driver) { status.textContent = "Pick a driver"; status.setAttribute("data-kind", ""); }
      else if (!sel.team) { status.textContent = "Pick a team"; status.setAttribute("data-kind", ""); }
      else if (same) { status.textContent = "Saved"; status.setAttribute("data-kind", "saved"); }
      else { status.textContent = "Ready to save"; status.setAttribute("data-kind", "ready"); }
      save.disabled = !complete || same;
    }

    grid1.addEventListener("click", function (e) {
      var chip = e.target.closest ? e.target.closest(".dchip") : null;
      if (!chip) { return; }
      sel.driver = chip.getAttribute("data-id");
      setMessage("", "");
      refresh();
    });
    grid2.addEventListener("click", function (e) {
      var chip = e.target.closest ? e.target.closest(".dchip") : null;
      if (!chip) { return; }
      sel.team = chip.getAttribute("data-team");
      setMessage("", "");
      refresh();
    });

    save.addEventListener("click", function () {
      if (!sel.driver || !sel.team) { return; }
      var mineToken = state.token;
      save.disabled = true;
      setMessage("", "Saving...");
      client.rpc("submit_season_prediction", { p_season: win.season, p_driver: sel.driver, p_team: sel.team })
        .then(function (res) {
          if (mineToken !== state.token) { return; }
          if (res.error) {
            setMessage("error", res.error.message || "Could not save your season picks.");
            if (/closed|not open/i.test(res.error.message || "")) { state.notice = res.error.message; load(); } else { refresh(); }
            return;
          }
          saved = { driver: sel.driver, team: sel.team };
          setMessage("ok", late
            ? "Season picks saved. They count for half points. You can change them until the late deadline."
            : "Season picks saved. You can change them until the lock time.");
          refresh();
        }).catch(function (err) {
          console.error(err);
          setMessage("error", "Something went wrong. Please try again.");
          refresh();
        });
    });

    refresh();
    card.hidden = false;
  }

  // ---------- Loading ----------

  function failure(err) {
    console.error(err);
    var text = (err && (err.message || "")) + " " + ((err && err.code) || "");
    els.body.textContent = "";
    els.sub.textContent = "";
    setFlag("closed", /does not exist|schema cache|PGRST20[0-9]|42P01/i.test(text)
      ? "Season picks need the latest database update (025_season_predictions.sql)."
      : "Could not load season picks. Please reload the page.");
    card.hidden = false;
  }

  function choose(rows) {
    var open = rows.filter(function (r) { return r.is_open || r.late_open; })
      .sort(function (a, b) { return a.season - b.season; });
    if (open.length) { return open[0]; }
    var all = rows.slice().sort(function (a, b) { return b.season - a.season; });
    return all.length ? all[0] : null;
  }

  function load() {
    var token = ++state.token;
    state.closeMs = null;
    var notice = state.notice;
    state.notice = null;
    var uid = state.user.id;

    Promise.all([
      client.from("season_prediction_windows").select("season, lock_at, late_lock_at, drivers_loaded, is_open, late_open"),
      client.from("group_members").select("joined_at").eq("user_id", uid).order("joined_at", { ascending: true }).limit(1)
    ]).then(function (res) {
      if (token !== state.token) { return; }
      if (res[0].error) { return failure(res[0].error); }
      if (res[1].error) { return failure(res[1].error); }

      var win = choose(res[0].data || []);
      var member = res[1].data && res[1].data[0];
      if (!win || !member) { hideCard(notice); return; }
      var joinedMs = Date.parse(member.joined_at);

      if (!win.drivers_loaded || !win.lock_at) { renderWaiting(win); return; }

      return Promise.all([
        client.from("drivers").select("id, code, full_name, team_name, car_number")
          .eq("season", win.season).eq("is_active", true).order("code"),
        client.from("season_predictions").select("drivers_pick, constructors_pick, half_value")
          .eq("user_id", uid).eq("season", win.season).limit(1)
      ]).then(function (res2) {
        if (token !== state.token) { return; }
        if (res2[0].error) { return failure(res2[0].error); }
        if (res2[1].error) { return failure(res2[1].error); }
        var drivers = res2[0].data || [];
        var mine = res2[1].data && res2[1].data[0] ? res2[1].data[0] : null;

        if (win.is_open) { renderForm(win, "open", drivers, mine); return; }
        if (win.late_open && (joinedMs >= Date.parse(win.lock_at) || (mine && mine.half_value))) {
          renderForm(win, "late", drivers, mine);
          return;
        }
        if (mine) { renderClosed(win, drivers, mine); return; }
        hideCard(notice);
      });
    }).catch(failure);
  }

  // Re-check when a deadline passes while the page is open.
  window.setInterval(function () {
    if (state.user && state.closeMs !== null && Date.now() >= state.closeMs) { load(); }
  }, 30000);

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) { return; }       // the page already tells signed-out visitors to sign in
    state.user = session.user;
    load();
  }).catch(function (err) { console.error(err); });
})();