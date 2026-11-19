// Lights Out: Championship tab on the Leaderboard page.
// Shows the real Drivers' and Constructors' championship tables (from the championship-standings edge function) and, where the
// season picks are visible, which league players picked each leader as champion.
// The League tab itself (standings.js) is untouched: this file only adds the tab bar and its own panel.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var P = window.LO_PROFILE;
  var tabsEl = document.getElementById("lb-tabs");
  var leagueTab = document.getElementById("lb-tab-league");
  var champTab = document.getElementById("lb-tab-champ");
  var panel = document.getElementById("champ-panel");

  if (!tabsEl || !panel || !window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  var state = { seasons: [], season: null, token: 0, opened: false, accessToken: null };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function formatPoints(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  // ---------- tabs ----------

  function show(name) {
    var champ = name === "champ";
    document.body.classList.toggle("champ-active", champ);
    leagueTab.setAttribute("aria-selected", champ ? "false" : "true");
    champTab.setAttribute("aria-selected", champ ? "true" : "false");
    panel.hidden = !champ;
    try { history.replaceState(null, "", champ ? "#championship" : window.location.pathname + window.location.search); } catch (e) { /* ignore */ }
    if (champ && !state.opened) {
      state.opened = true;
      start();
    }
  }

  leagueTab.addEventListener("click", function () { show("league"); });
  champTab.addEventListener("click", function () { show("champ"); });

  // ---------- data ----------

  function loadStandings(season) {
    return fetch(cfg.SUPABASE_URL + "/functions/v1/championship-standings?season=" + encodeURIComponent(season), {
      headers: { Authorization: "Bearer " + state.accessToken, apikey: cfg.SUPABASE_PUBLISHABLE_KEY }
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) { throw new Error(body && body.error ? body.error : "HTTP " + res.status); }
        return body;
      });
    });
  }

  // Season picks are only returned by the database once a player's window has closed, so whatever comes back may be shown.
  function loadPicks(season) {
    return Promise.all([
      client.from("season_predictions").select("user_id, drivers_pick, constructors_pick, half_value").eq("season", season),
      client.from("drivers").select("id, code").eq("season", season),
      client.from("profiles").select("id, display_name"),
      client.from("player_xp").select("user_id, avatar")
    ]).then(function (res) {
      var out = { rows: [], codeById: {}, names: {}, avatars: {} };
      if (!res[0].error) { out.rows = res[0].data || []; }
      if (!res[1].error) { (res[1].data || []).forEach(function (d) { out.codeById[d.id] = String(d.code).toUpperCase(); }); }
      if (!res[2].error) { (res[2].data || []).forEach(function (p) { out.names[p.id] = p.display_name; }); }
      if (!res[3].error) { (res[3].data || []).forEach(function (x) { if (x.avatar) { out.avatars[x.user_id] = x.avatar; } }); }
      return out;
    }, function () { return { rows: [], codeById: {}, names: {}, avatars: {} }; });
  }

  // ---------- drawing ----------

  function pickers(list, picks) {
    var cell = el("td", "ch-picked");
    if (list.length === 0) { return cell; }
    var wrap = el("span", "ch-chips");
    list.slice(0, 5).forEach(function (r) {
      var chip = el("span", "ch-chip");
      var name = picks.names[r.user_id] || "Player";
      chip.title = name + (r.half_value ? " (half value)" : "");
      if (P) { chip.innerHTML = P.avatarSvg(picks.avatars[r.user_id] || null, 22, r.user_id); }
      wrap.appendChild(chip);
    });
    if (list.length > 5) { wrap.appendChild(el("span", "ch-more", "+" + (list.length - 5))); }
    cell.appendChild(wrap);
    return cell;
  }

  function table(title, rows, columns) {
    var box = el("section", "ch-card");
    box.appendChild(el("h3", "", title));
    var scroll = el("div", "ch-scroll");
    var t = el("table", "ch-table");
    var head = document.createElement("thead");
    var hr = document.createElement("tr");
    columns.forEach(function (c) {
      var th = el("th", c.cls || "", c.label);
      th.scope = "col";
      hr.appendChild(th);
    });
    head.appendChild(hr);
    t.appendChild(head);
    var body = document.createElement("tbody");
    rows.forEach(function (r) { body.appendChild(r); });
    t.appendChild(body);
    scroll.appendChild(t);
    box.appendChild(scroll);
    return box;
  }

  function render(standings, picks, season) {
    panel.textContent = "";

    // header: season, status
    var head = el("div", "ch-head");
    if (state.seasons.length > 1) {
      var field = el("label", "ch-season", "Season ");
      var select = document.createElement("select");
      state.seasons.forEach(function (s) {
        var o = el("option", "", String(s));
        o.value = String(s);
        select.appendChild(o);
      });
      select.value = String(season);
      select.addEventListener("change", function () { state.season = Number(select.value); load(); });
      field.appendChild(select);
      head.appendChild(field);
    } else {
      head.appendChild(el("p", "ch-season", "Season " + season));
    }
    var status = standings.round
      ? "After round " + standings.round + " \u00b7 updated " + new Date(standings.fetched_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    head.appendChild(el("p", "ch-status", status));
    panel.appendChild(head);

    if (standings.drivers.length === 0 && standings.constructors.length === 0) {
      panel.appendChild(el("p", "ch-empty", "No championship standings yet for " + season + ". They appear after the first race."));
      return;
    }

    var driverRows = standings.drivers.map(function (d) {
      var tr = document.createElement("tr");
      tr.appendChild(el("th", "ch-pos" + (d.position === 1 ? " lead" : ""), String(d.position)));
      var who = el("td", "ch-who");
      who.appendChild(el("b", "", d.code || d.name.split(" ").slice(-1)[0].slice(0, 3).toUpperCase()));
      who.appendChild(el("span", "ch-name", d.name));
      who.appendChild(el("span", "ch-team", d.team));
      tr.appendChild(who);
      tr.appendChild(el("td", "ch-num", formatPoints(d.points)));
      tr.appendChild(el("td", "ch-num ch-wins", String(d.wins)));
      var list = d.code ? picks.rows.filter(function (r) { return picks.codeById[r.drivers_pick] === d.code; }) : [];
      tr.appendChild(pickers(list, picks));
      return tr;
    });

    var teamRows = standings.constructors.map(function (c) {
      var tr = document.createElement("tr");
      tr.appendChild(el("th", "ch-pos" + (c.position === 1 ? " lead" : ""), String(c.position)));
      var who = el("td", "ch-who");
      who.appendChild(el("b", "ch-teamname", c.name));
      tr.appendChild(who);
      tr.appendChild(el("td", "ch-num", formatPoints(c.points)));
      tr.appendChild(el("td", "ch-num ch-wins", String(c.wins)));
      var key = c.name.trim().toLowerCase();
      var list = picks.rows.filter(function (r) { return String(r.constructors_pick).trim().toLowerCase() === key; });
      tr.appendChild(pickers(list, picks));
      return tr;
    });

    var cols = [
      { label: "Pos", cls: "ch-pos" },
      { label: "Driver" },
      { label: "Pts", cls: "ch-num" },
      { label: "Wins", cls: "ch-num ch-wins" },
      { label: "Picked", cls: "ch-picked" }
    ];
    var grid = el("div", "ch-grid");
    grid.appendChild(table("Drivers' championship", driverRows, cols));
    cols = cols.slice();
    cols[1] = { label: "Team" };
    grid.appendChild(table("Constructors' championship", teamRows, cols));
    panel.appendChild(grid);

    var note = el("p", "ch-note", "\u201cPicked\u201d shows league players who chose that driver or team as champion. A player's pick appears here only after their season-picks window has closed.");
    panel.appendChild(note);
  }

  function load() {
    var my = ++state.token;
    var season = state.season;
    panel.textContent = "";
    panel.appendChild(el("p", "ch-empty", "Loading..."));
    Promise.all([loadStandings(season), loadPicks(season)]).then(function (both) {
      if (my !== state.token) { return; }
      render(both[0], both[1], season);
    }).catch(function (err) {
      console.error(err);
      if (my !== state.token) { return; }
      panel.textContent = "";
      panel.appendChild(el("p", "ch-empty ch-error", "Could not load the championship standings. Please try again in a moment."));
    });
  }

  function start() {
    client.from("events").select("season, start_date").then(function (res) {
      if (res.error) { throw res.error; }
      var first = {};
      (res.data || []).forEach(function (e) {
        if (e.season >= 9000) { return; }
        if (first[e.season] === undefined || e.start_date < first[e.season]) { first[e.season] = e.start_date; }
      });
      state.seasons = Object.keys(first).map(Number).sort(function (a, b) { return b - a; });
      if (state.seasons.length === 0) { throw new Error("no seasons"); }
      var today = new Date().toISOString().slice(0, 10);
      var started = state.seasons.filter(function (s) { return first[s] <= today; });
      state.season = started.length ? started[0] : state.seasons[0];
      load();
    }).catch(function (err) {
      console.error(err);
      panel.textContent = "";
      panel.appendChild(el("p", "ch-empty ch-error", "Could not load the championship standings. Please try again in a moment."));
    });
  }

  // ---------- begin: only signed-in players get the tab ----------

  client.auth.getSession().then(function (r) {
    var session = r.data && r.data.session;
    if (!session) { return; }
    state.accessToken = session.access_token;
    tabsEl.hidden = false;
    if (window.location.hash === "#championship") { show("champ"); }
  });
})();
