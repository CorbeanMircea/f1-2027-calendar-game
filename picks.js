// Lights Out picks reveal: once a session locks, shows what everyone predicted.
// Layout: one compact comparison table (rows = places, columns = the room's most popular pick, then each player),
// plus a "Season picks" view for the Drivers' and Constructors' champion picks.
// The database only returns other players' picks after the deadline, so this page cannot show anything early
// even if it wanted to. Reading and counting are unchanged; only the layout is new.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var E = window.LO_PICKS;
  var P = window.LO_PROFILE;
  var $ = function (id) { return document.getElementById(id); };
  var msgEl = $("pk-msg");
  var controls = $("pk-controls");
  var weekendBox = $("pk-weekend");
  var eventSel = $("pk-event");
  var tabsEl = $("pk-tabs");
  var summaryEl = $("pk-summary");
  var boardEl = $("pk-board");

  var TYPE_LABEL = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };
  var TYPE_ORDER = { sprint_qualifying: 1, sprint: 2, qualifying: 3, race: 4 };
  var LOCK_TYPE = { qualifying: "qualifying", race: "qualifying", sprint_qualifying: "sprint_qualifying", sprint: "sprint_qualifying" };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function setMsg(kind, text) {
    msgEl.className = "message" + (kind ? " " + kind : "");
    msgEl.textContent = text || "";
  }

  if (!window.supabase || !E || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    setMsg("error", "Site configuration is incomplete.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  var data = { me: null, drivers: {}, names: {}, avatars: {}, events: [], byEvent: {}, sessions: {}, approved: {}, windows: [] };
  var sel = { view: "session", eventId: null, sessionId: null, season: null };
  var live = { actual: null, points: null };
  var requestId = 0;
  var scrollCheck = null;

  // ---------- locking (the same rule as the database) ----------

  function lockMs(session) {
    var lockType = LOCK_TYPE[session.session_type];
    var all = data.byEvent[session.event_id] || [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].session_type === lockType && all[i].start_utc) { return Date.parse(all[i].start_utc); }
    }
    return null;
  }

  function isLocked(session) {
    var ms = lockMs(session);
    return ms !== null && ms <= Date.now();
  }

  function when(ms) {
    return new Date(ms).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function sessionsOfEvent(id) {
    return (data.byEvent[id] || []).slice().sort(function (a, b) {
      return (TYPE_ORDER[a.session_type] || 9) - (TYPE_ORDER[b.session_type] || 9);
    });
  }

  // ---------- season windows (the main window closes at the first Round 1 session) ----------

  function seasonWindows() {
    return data.windows.filter(function (w) { return w.season < 9000; });
  }

  function closedSeasons() {
    return seasonWindows().filter(function (w) { return w.lock_at && Date.parse(w.lock_at) <= Date.now(); })
      .sort(function (a, b) { return b.season - a.season; });
  }

  function nextSeasonLockMs() {
    var next = null;
    seasonWindows().forEach(function (w) {
      var ms = w.lock_at ? Date.parse(w.lock_at) : null;
      if (ms && ms > Date.now() && (next === null || ms < next)) { next = ms; }
    });
    return next;
  }

  function windowOf(season) {
    return seasonWindows().filter(function (w) { return w.season === season; })[0] || null;
  }

  // ---------- small pieces ----------

  function driverCode(id) { var d = data.drivers[id]; return d ? d.code : String(id); }

  function driverName(id) {
    var d = data.drivers[id];
    if (!d) { return String(id); }
    var parts = String(d.full_name || "").split(" ");
    return parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
  }

  // state: "hit", "near", "miss" or "" (no result yet)
  function pick(id, only, state) {
    var c = el("span", "cp" + (only ? " only" : "") + (state ? " " + state : ""), driverCode(id));
    c.title = driverName(id) + (only ? " (nobody else made this pick)" : "");
    return c;
  }

  function dash() { return el("span", "cp-none", "\u2014"); }

  function roomItem(label, count, total) {
    var s = el("span", "rm" + (count > total / 2 ? " lead" : ""));
    s.appendChild(el("b", "", label));
    s.appendChild(el("i", "", String(count)));
    return s;
  }

  // Scored session: best score first. Otherwise you first, then by name.
  function sortPlayers(ids, points) {
    return ids.slice().sort(function (a, b) {
      if (points) {
        var d = (points[b] === undefined ? -1 : points[b]) - (points[a] === undefined ? -1 : points[a]);
        if (d !== 0) { return d; }
      } else {
        if (a === data.me) { return -1; }
        if (b === data.me) { return 1; }
      }
      return String(data.names[a]).localeCompare(String(data.names[b]));
    });
  }

  function actualChip(id) {
    var c = el("span", "cp act", driverCode(id));
    c.title = driverName(id);
    return c;
  }

  function actualList(ids) {
    if (!ids || ids.length === 0) { return dash(); }
    var list = el("span", "cp-list");
    ids.forEach(function (id) { list.appendChild(actualChip(id)); });
    return list;
  }

  function stateAt(id, i, actual) {
    if (!actual) { return ""; }
    var j = actual.indexOf(id);
    return j === i ? "hit" : (j !== -1 ? "near" : "miss");
  }

  function stateIn(id, actual) {
    if (!actual) { return ""; }
    return actual.indexOf(id) !== -1 ? "hit" : "miss";
  }

  // ---------- the comparison table ----------
  // players: user ids (already sorted). sections: [{title?, rows: [{label, room: [node], cell: function (uid) -> node}]}]

  function columnHead(uid, half, points) {
    var th = el("th", "pl" + (uid === data.me ? " me" : ""));
    th.scope = "col";
    var box = el("div", "pl-in");
    var av = el("span", "pk-av");
    if (P) {
      var a = data.avatars[uid];
      av.innerHTML = P.avatarSvg(a ? a : null, 28, uid);
    }
    box.appendChild(av);
    box.appendChild(el("span", "pl-name", data.names[uid] || "Player"));
    if (uid === data.me) { box.appendChild(el("span", "pl-note", "you")); }
    if (half && half(uid)) { box.appendChild(el("span", "pl-note", "half value")); }
    if (points && points[uid] !== undefined) { box.appendChild(el("span", "pl-pts", points[uid] + " pts")); }
    th.appendChild(box);
    return th;
  }

  function buildTable(players, sections, total, opts) {
    var withResult = !!(opts && opts.result);
    var table = el("table", "pk-matrix" + (opts && opts.season ? " is-season" : "") + (withResult ? " has-result" : ""));
    table.style.setProperty("--n", String(players.length));

    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    var corner = el("th", "pos");
    corner.scope = "col";
    corner.appendChild(el("span", "sr", "Pick"));
    hr.appendChild(corner);
    if (withResult) {
      var resHead = el("th", "res-col");
      resHead.scope = "col";
      resHead.appendChild(el("span", "", "Result"));
      hr.appendChild(resHead);
    }
    var roomHead = el("th", "rm-col");
    roomHead.scope = "col";
    roomHead.appendChild(el("span", "", "Most picked"));
    roomHead.appendChild(el("small", "", "players"));
    hr.appendChild(roomHead);
    players.forEach(function (u) { hr.appendChild(columnHead(u, opts && opts.half, opts && opts.points)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    sections.forEach(function (sec) {
      if (sec.title) {
        var st = el("tr", "sec");
        var sh = document.createElement("th");
        sh.colSpan = players.length + (withResult ? 3 : 2);
        sh.appendChild(el("span", "", sec.title));
        st.appendChild(sh);
        tbody.appendChild(st);
      }
      sec.rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var label = el("th", "pos", r.label);
        label.scope = "row";
        tr.appendChild(label);
        if (withResult) {
          var res = el("td", "res-col");
          res.appendChild(r.result ? r.result() : dash());
          tr.appendChild(res);
        }
        var room = el("td", "rm-col");
        r.room.forEach(function (n) { room.appendChild(n); });
        if (r.room.length === 0) { room.appendChild(dash()); }
        tr.appendChild(room);
        players.forEach(function (u) {
          var td = el("td", u === data.me ? "me" : "");
          td.appendChild(r.cell(u));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    });
    table.appendChild(tbody);
    return table;
  }

  function showBoard(table, legendText, withResult) {
    boardEl.textContent = "";
    var guide = el("div", "pk-guide");
    guide.appendChild(el("strong", "pk-guide-title", "How to read this"));
    var legend = el("p", "pk-legend");
    legend.appendChild(el("span", "cp only", "VER"));
    legend.appendChild(document.createTextNode(" " + legendText));
    guide.appendChild(legend);
    guide.appendChild(el("p", "pk-guide-you", "The highlighted column is your picks."));
    if (withResult) {
      var key = el("p", "pk-legend pk-result-key");
      key.appendChild(el("span", "cp hit", "VER"));
      key.appendChild(document.createTextNode(" exact "));
      key.appendChild(el("span", "cp near", "VER"));
      key.appendChild(document.createTextNode(" right driver or group, wrong place "));
      key.appendChild(el("span", "cp miss", "VER"));
      key.appendChild(document.createTextNode(" missed."));
      guide.appendChild(key);
    }

    var hint = el("p", "pk-hint", "Swipe to compare every player's picks \u2192");
    hint.hidden = true;
    var wrap = el("div", "pk-scroll");
    wrap.appendChild(table);
    boardEl.appendChild(guide);
    boardEl.appendChild(hint);
    boardEl.appendChild(wrap);
    boardEl.hidden = false;

    scrollCheck = function () { hint.hidden = !(wrap.scrollWidth > wrap.clientWidth + 2); };
    scrollCheck();
  }

  window.addEventListener("resize", function () { if (scrollCheck) { scrollCheck(); } });

  // ---------- one session ----------

  function sessionSections(type, byUser, summary, players, actual) {
    var total = summary.total;
    var out = [];

    function sec(key) { return summary.sections.filter(function (s) { return s.key === key; })[0]; }

    function orderedSection(title, key, secKey) {
      var listOf = function (p) { return E.list(p, key); };
      var act = actual ? E.list(actual, key) : null;
      var flags = {};
      players.forEach(function (u) { flags[u] = E.onlyPicks(u, key, "slot", byUser, listOf); });
      return {
        title: title,
        rows: sec(secKey).rows.map(function (r, i) {
          return {
            label: "P" + r.pos,
            room: r.top ? [roomItem(driverCode(r.top.id), r.top.count, total)] : [],
            result: act ? function () { return act[i] ? actualChip(act[i]) : dash(); } : null,
            cell: function (u) {
              var id = listOf(byUser[u])[i];
              return id ? pick(id, flags[u][i], stateAt(id, i, act)) : dash();
            }
          };
        })
      };
    }

    function groupRow(label, secKey, flagKey, listOf, maxRoom, act) {
      var s = sec(secKey);
      var flags = {};
      var size = 0;
      players.forEach(function (u) {
        flags[u] = E.onlyPicks(u, flagKey, "any", byUser, listOf);
        size = Math.max(size, listOf(byUser[u]).length);
      });
      var shown = Math.min(Math.max(size, 1), maxRoom);
      return {
        label: label,
        room: s ? s.rows.slice(0, shown).map(function (r) { return roomItem(driverCode(r.id), r.count, total); }) : [],
        result: act ? function () { return actualList(act); } : null,
        cell: function (u) {
          var ids = listOf(byUser[u]);
          if (ids.length === 0) { return dash(); }
          var list = el("span", "cp-list");
          ids.forEach(function (id, i) { list.appendChild(pick(id, flags[u][i], stateIn(id, act))); });
          return list;
        }
      };
    }

    if (type === "qualifying" || type === "sprint_qualifying") {
      var q1 = function (p) { return E.list(p, "q1_out"); };
      var q2 = function (p) { return E.list(p, "q2_out"); };
      out.push({ title: "Knocked out", rows: [
        groupRow("Q1", "q1", "q1_out", q1, 6, actual ? E.list(actual, "q1_out") : null),
        groupRow("Q2", "q2", "q2_out", q2, 6, actual ? E.list(actual, "q2_out") : null)
      ] });
      out.push(orderedSection("Q3 order", "q3_order", "q3"));
      return out;
    }

    out.push(orderedSection("Top 8", "top8", "top8"));
    if (type === "race") {
      var flOf = function (p) { return p.fastest_lap ? [p.fastest_lap] : []; };
      var dnOf = function (p) { return E.dnfList(p); };
      var actDnf = actual ? E.dnfList(actual) : null;
      var actFl = actual && actual.fastest_lap ? [actual.fastest_lap] : (actual ? [] : null);
      var countSec = sec("dnfcount");
      var countRoom = countSec ? countSec.rows.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 2)
        .map(function (r) { return roomItem(r.label, r.count, total); }) : [];
      out.push({ title: "Extras", rows: [
        groupRow("FL", "fl", "fl", flOf, 3, actFl),
        {
          label: "DNFs",
          room: countRoom,
          result: actDnf ? function () { return el("span", "cp-num", actDnf.length === 0 ? "None" : String(actDnf.length)); } : null,
          cell: function (u) {
            var p = byUser[u];
            var n = p.any_dnf ? Number(p.dnf_count) || 0 : 0;
            var diff = actDnf ? Math.abs(n - actDnf.length) : -1;
            var c = el("span", "cp-num" + (diff === 0 ? " hit" : (diff === 1 ? " near" : (diff > 1 ? " miss" : ""))), n === 0 ? "None" : String(n));
            return c;
          }
        },
        groupRow("DNF by", "dnf", "dnf", dnOf, 6, actDnf)
      ] });
    }
    return out;
  }

  function sessionStrip(session, byUser) {
    var type = session.session_type;
    var allIds = Object.keys(data.names);
    var missing = allIds.filter(function (u) { return !byUser[u]; }).map(function (u) { return data.names[u]; }).sort();
    var strip = el("div", "pk-strip");

    var line = el("p");
    line.appendChild(el("b", "", Object.keys(byUser).length + " of " + allIds.length));
    line.appendChild(document.createTextNode(" predicted the " + TYPE_LABEL[type] + " \u00b7 locked " + when(lockMs(session))));
    strip.appendChild(line);
    if (missing.length > 0) { strip.appendChild(el("p", "muted", "No prediction: " + missing.join(", "))); }

    var tail = el("p", "grow");
    if (data.approved[session.id]) {
      var a = el("a", "", "See how it was scored \u2192");
      a.href = "scorecard.html?session=" + encodeURIComponent(session.id);
      tail.appendChild(a);
    } else {
      tail.className = "grow muted";
      tail.textContent = "Score check opens once an admin approves the result.";
    }
    strip.appendChild(tail);
    return strip;
  }

  function renderSession(byUser) {
    var session = data.sessions[sel.sessionId];
    var predictedIds = Object.keys(byUser);

    summaryEl.textContent = "";
    summaryEl.appendChild(sessionStrip(session, byUser));
    summaryEl.hidden = false;

    if (predictedIds.length === 0) {
      boardEl.textContent = "";
      boardEl.appendChild(el("p", "pk-empty", "Nobody predicted this session."));
      boardEl.hidden = false;
      return;
    }

    var actual = live.actual;
    var points = actual && live.points && Object.keys(live.points).length > 0 ? live.points : null;
    var players = sortPlayers(predictedIds, points);
    var summary = E.summarize(session.session_type, byUser);
    var table = buildTable(players, sessionSections(session.session_type, byUser, summary, players, actual), summary.total, {
      result: !!actual,
      points: points
    });
    showBoard(table, "A star marks a pick nobody else made. Most picked shows the most common choice and how many players chose it; yellow means a majority.", !!actual);
  }

  function loadSession() {
    var my = ++requestId;
    var sid = sel.sessionId;
    summaryEl.hidden = true;
    boardEl.hidden = true;
    setMsg("", "Loading...");
    var extra = data.approved[sid] ? Promise.all([
      client.from("results").select("data").eq("session_id", sid).eq("status", "approved").limit(1),
      client.from("scores").select("user_id, points").eq("session_id", sid)
    ]).then(function (r) {
      var points = {};
      if (!r[1].error) { (r[1].data || []).forEach(function (x) { points[x.user_id] = Number(x.points) || 0; }); }
      var row = !r[0].error && r[0].data && r[0].data[0] ? r[0].data[0] : null;
      return { actual: row && row.data ? row.data : null, points: points };
    }, function () { return { actual: null, points: null }; }) : Promise.resolve({ actual: null, points: null });

    return Promise.all([client.from("predictions").select("user_id, picks").eq("session_id", sid), extra]).then(function (both) {
      var res = both[0];
      if (my !== requestId) { return; }
      if (res.error) { throw res.error; }
      live = both[1];
      var byUser = {};
      (res.data || []).forEach(function (r) { byUser[r.user_id] = r.picks || {}; });
      setMsg("", "");
      renderSession(byUser);
    }).catch(function (err) {
      console.error(err);
      if (my === requestId) { setMsg("error", "Could not load the picks. Please reload the page. (" + (err.message || "error") + ")"); }
    });
  }

  // ---------- season picks ----------

  function seasonSections(byUser, players) {
    var total = players.length;
    var drivers = {};
    var teams = {};
    players.forEach(function (u) {
      var r = byUser[u];
      drivers[r.drivers_pick] = (drivers[r.drivers_pick] || 0) + 1;
      teams[r.constructors_pick] = (teams[r.constructors_pick] || 0) + 1;
    });

    function top(map) {
      return Object.keys(map).map(function (k) { return { id: k, count: map[k] }; })
        .sort(function (a, b) { return b.count - a.count || (a.id < b.id ? -1 : 1); }).slice(0, 3);
    }

    return [{ rows: [
      {
        label: "Drivers' champion",
        room: top(drivers).map(function (r) { return roomItem(driverCode(r.id), r.count, total); }),
        cell: function (u) {
          var id = byUser[u].drivers_pick;
          return pick(id, total > 1 && drivers[id] === 1);
        }
      },
      {
        label: "Constructors' champion",
        room: top(teams).map(function (r) { return roomItem(r.id, r.count, total); }),
        cell: function (u) {
          var name = byUser[u].constructors_pick;
          return el("span", "cp-team" + (total > 1 && teams[name] === 1 ? " only" : ""), name);
        }
      }
    ] }];
  }

  function seasonStrip(byUser) {
    var allIds = Object.keys(data.names);
    var missing = allIds.filter(function (u) { return !byUser[u]; }).map(function (u) { return data.names[u]; }).sort();
    var win = windowOf(sel.season);
    var strip = el("div", "pk-strip");

    var line = el("p");
    line.appendChild(el("b", "", Object.keys(byUser).length + " of " + allIds.length));
    line.appendChild(document.createTextNode(" players' season picks are visible for " + sel.season +
      (win && win.lock_at ? " \u00b7 locked " + when(Date.parse(win.lock_at)) : "")));
    strip.appendChild(line);

    if (closedSeasons().length > 1) {
      var field = el("label", "pk-season-pick");
      field.appendChild(document.createTextNode("Season "));
      var s = document.createElement("select");
      closedSeasons().forEach(function (w) {
        var o = el("option", "", String(w.season));
        o.value = String(w.season);
        s.appendChild(o);
      });
      s.value = String(sel.season);
      s.addEventListener("change", function () { sel.season = Number(s.value); loadSeason(); });
      field.appendChild(s);
      strip.appendChild(field);
    }

    if (missing.length > 0) {
      strip.appendChild(el("p", "muted", "Not visible yet: " + missing.join(", ") +
        ". They have not picked, or picked after the lock; those picks open at the late deadline (Round 5)."));
    }
    return strip;
  }

  function renderSeason(byUser) {
    summaryEl.textContent = "";
    summaryEl.appendChild(seasonStrip(byUser));
    summaryEl.hidden = false;

    var ids = Object.keys(byUser);
    if (ids.length === 0) {
      boardEl.textContent = "";
      boardEl.appendChild(el("p", "pk-empty", "No season picks are visible for " + sel.season + " yet."));
      boardEl.hidden = false;
      return;
    }
    var players = sortPlayers(ids);
    var table = buildTable(players, seasonSections(byUser, players), players.length, {
      season: true,
      half: function (u) { return !!byUser[u].half_value; }
    });
    showBoard(table, "A star marks a pick nobody else made. Most picked shows the most common choice and how many players chose it; yellow means a majority.");
  }

  function loadSeason() {
    var my = ++requestId;
    var season = sel.season;
    summaryEl.hidden = true;
    boardEl.hidden = true;
    setMsg("", "Loading...");
    return client.from("season_predictions").select("user_id, drivers_pick, constructors_pick, half_value").eq("season", season)
      .then(function (res) {
        if (my !== requestId) { return; }
        if (res.error) { throw res.error; }
        var byUser = {};
        (res.data || []).forEach(function (r) { byUser[r.user_id] = r; });
        setMsg("", "");
        renderSeason(byUser);
      }).catch(function (err) {
        console.error(err);
        if (my === requestId) { setMsg("error", "Could not load the season picks. Please reload the page. (" + (err.message || "error") + ")"); }
      });
  }

  // ---------- controls ----------

  function fillEvents() {
    eventSel.textContent = "";
    data.events.forEach(function (ev) {
      var o = el("option", "", "Round " + ev.round + " \u00b7 " + ev.name + " (" + ev.season + ")");
      o.value = ev.id;
      eventSel.appendChild(o);
    });
    if (sel.eventId) { eventSel.value = sel.eventId; }
    weekendBox.hidden = data.events.length === 0;
  }

  function fillTabs() {
    controls.setAttribute("data-view", sel.view);
    tabsEl.textContent = "";
    sessionsOfEvent(sel.eventId).forEach(function (s) {
      var b = el("button", "pk-tab", TYPE_LABEL[s.session_type] || s.session_type);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-id", s.id);
      var locked = isLocked(s);
      b.disabled = !locked;
      b.setAttribute("aria-selected", sel.view === "session" && s.id === sel.sessionId ? "true" : "false");
      var ms = lockMs(s);
      b.appendChild(el("small", "", locked ? (data.approved[s.id] ? "SCORED" : "LOCKED") : (ms ? "HIDDEN UNTIL " + when(ms).toUpperCase() : "TIME TO BE CONFIRMED")));
      tabsEl.appendChild(b);
    });

    if (seasonWindows().length > 0) {
      var closed = closedSeasons().length > 0;
      var sb = el("button", "pk-tab pk-tab-season", "Season picks");
      sb.type = "button";
      sb.setAttribute("role", "tab");
      sb.setAttribute("data-view", "season");
      sb.disabled = !closed;
      sb.setAttribute("aria-selected", sel.view === "season" ? "true" : "false");
      var next = nextSeasonLockMs();
      sb.appendChild(el("small", "", closed ? "LOCKED" : (next ? "HIDDEN UNTIL " + when(next).toUpperCase() : "NOT OPEN YET")));
      tabsEl.appendChild(sb);
    }
  }

  function chooseEvent(id, wantedSession) {
    sel.eventId = id;
    sel.view = "session";
    var list = sessionsOfEvent(id).filter(isLocked);
    var keep = list.some(function (s) { return s.id === (wantedSession || sel.sessionId); });
    sel.sessionId = keep ? (wantedSession || sel.sessionId) : (list.length ? list[list.length - 1].id : null);
    fillEvents();
    fillTabs();
    if (sel.sessionId) { loadSession(); }
  }

  function chooseSeason() {
    sel.view = "season";
    if (sel.season === null) { sel.season = closedSeasons()[0].season; }
    fillTabs();
    loadSeason();
  }

  function reload() {
    if (sel.view === "season" && sel.season !== null) { loadSeason(); }
    else if (sel.sessionId) { loadSession(); }
  }

  eventSel.addEventListener("change", function () { sel.sessionId = null; chooseEvent(eventSel.value); });
  tabsEl.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".pk-tab") : null;
    if (!b || b.disabled) { return; }
    if (b.getAttribute("data-view") === "season") { chooseSeason(); return; }
    sel.view = "session";
    sel.sessionId = b.getAttribute("data-id");
    fillTabs();
    loadSession();
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { reload(); } });

  // ---------- start ----------

  client.auth.getSession().then(function (r) {
    var session = r.data && r.data.session;
    if (!session) {
      msgEl.textContent = "";
      msgEl.appendChild(document.createTextNode("Sign in on the "));
      var a = el("a", "", "Account page");
      a.href = "account.html";
      msgEl.appendChild(a);
      msgEl.appendChild(document.createTextNode(" to see everyone's picks."));
      return null;
    }
    data.me = session.user.id;
    setMsg("", "Loading...");

    return Promise.all([
      client.from("sessions").select("id, event_id, session_type, start_utc"),
      client.from("events").select("id, name, round, season, start_date"),
      client.from("drivers").select("id, code, full_name"),
      client.from("profiles").select("id, display_name"),
      client.from("results").select("session_id").eq("status", "approved"),
      client.from("player_xp").select("user_id, avatar"),
      client.from("season_prediction_windows").select("season, lock_at, late_lock_at")
    ]).then(function (res) {
      for (var i = 0; i < 5; i++) { if (res[i].error) { throw res[i].error; } }
      (res[0].data || []).forEach(function (s) { data.sessions[s.id] = s; (data.byEvent[s.event_id] = data.byEvent[s.event_id] || []).push(s); });
      var events = (res[1].data || []).sort(function (a, b) { return String(b.start_date).localeCompare(String(a.start_date)); });
      (res[2].data || []).forEach(function (d) { data.drivers[d.id] = d; });
      (res[3].data || []).forEach(function (p) { data.names[p.id] = p.display_name; });
      (res[4].data || []).forEach(function (r) { data.approved[r.session_id] = true; });
      if (!res[5].error) { (res[5].data || []).forEach(function (x) { if (x.avatar) { data.avatars[x.user_id] = x.avatar; } }); }
      if (!res[6].error) { data.windows = res[6].data || []; }

      data.events = events.filter(function (ev) { return (data.byEvent[ev.id] || []).some(isLocked); });
      var closed = closedSeasons();
      if (data.events.length === 0 && closed.length === 0) {
        var next = null;
        Object.keys(data.sessions).forEach(function (id) {
          var ms = lockMs(data.sessions[id]);
          if (ms && ms > Date.now() && (!next || ms < next.ms)) { next = { ms: ms, ev: data.sessions[id].event_id }; }
        });
        var evName = next ? (events.filter(function (e) { return e.id === next.ev; })[0] || {}).name : "";
        setMsg("", next
          ? "Nothing to reveal yet. Picks become visible when predictions lock: " + evName + ", " + when(next.ms) + "."
          : "Nothing to reveal yet. Picks become visible when predictions lock.");
        return;
      }

      var params = new URLSearchParams(window.location.search);
      var wantSession = params.get("session");
      var wantEvent = wantSession && data.sessions[wantSession] ? data.sessions[wantSession].event_id : params.get("event");
      var first = wantEvent && data.events.some(function (e) { return e.id === wantEvent; }) ? wantEvent : (data.events[0] ? data.events[0].id : null);
      var wantSeason = Number(params.get("season"));
      var seasonView = params.get("view") === "season" && closed.length > 0;
      if (seasonView || data.events.length === 0) {
        sel.season = closed.some(function (w) { return w.season === wantSeason; }) ? wantSeason : closed[0].season;
      }

      controls.hidden = false;
      if (seasonView || data.events.length === 0) {
        sel.eventId = first;
        fillEvents();
        chooseSeason();
      } else {
        chooseEvent(first, wantSession && data.sessions[wantSession] ? wantSession : null);
      }
    });
  }).catch(function (err) {
    console.error(err);
    setMsg("error", "Could not load the picks. Please reload the page. (" + (err.message || "error") + ")");
  });
})();
