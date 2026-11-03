// Lights Out picks reveal: once a session locks, shows what everyone predicted.
// The database only returns other players' picks after the deadline, so this page cannot
// show anything early even if it wanted to.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var E = window.LO_PICKS;
  var P = window.LO_PROFILE;
  var $ = function (id) { return document.getElementById(id); };
  var msgEl = $("pk-msg");
  var controls = $("pk-controls");
  var eventSel = $("pk-event");
  var tabsEl = $("pk-tabs");
  var summaryEl = $("pk-summary");
  var roomEl = $("pk-room");
  var playersEl = $("pk-players");

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
  var data = { me: null, drivers: {}, names: {}, avatars: {}, events: [], byEvent: {}, sessions: {}, approved: {} };
  var sel = { eventId: null, sessionId: null };
  var requestId = 0;

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

  // ---------- small pieces ----------

  function driverCode(id) { var d = data.drivers[id]; return d ? d.code : String(id); }

  function driverName(id) {
    var d = data.drivers[id];
    if (!d) { return String(id); }
    var parts = String(d.full_name || "").split(" ");
    return parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
  }

  function chip(id, only, pos) {
    var c = el("span", "chip" + (only ? " only" : ""));
    if (pos) { c.appendChild(el("span", "pos", pos)); }
    c.appendChild(document.createTextNode(driverCode(id)));
    if (only) { c.title = "Nobody else made this pick"; }
    return c;
  }

  function voteRow(label, nameNode, count, total, lead) {
    var row = el("div", "vr" + (lead ? " lead" : ""));
    var name = el("span", "vr-name");
    if (label) { name.appendChild(el("span", "vr-pos", label)); }
    name.appendChild(nameNode);
    row.appendChild(name);
    var bar = el("span", "vr-bar");
    var fill = document.createElement("i");
    fill.style.width = (total > 0 ? Math.round((count / total) * 100) : 0) + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el("span", "vr-n", count + " of " + total));
    return row;
  }

  function driverNode(id) {
    var s = el("span", "dr");
    s.appendChild(el("b", "", driverCode(id)));
    s.appendChild(el("i", "", driverName(id)));
    return s;
  }

  // ---------- the room's view ----------

  function roomSection(sec, total) {
    var box = el("section", "sc-section");
    var head = document.createElement("header");
    head.appendChild(el("h3", "", sec.title));
    box.appendChild(head);
    var body = el("div", "pk-body");

    if (sec.kind === "ordered") {
      sec.rows.forEach(function (r) {
        if (!r.top) { return; }
        body.appendChild(voteRow("P" + r.pos, driverNode(r.top.id), r.top.count, total, r.top.count > total / 2));
        if (r.others.length) {
          var also = el("p", "vr-also", "Also: " + r.others.slice(0, 3).map(function (o) { return driverCode(o.id) + " " + o.count; }).join(", ") +
            (r.others.length > 3 ? ", and " + (r.others.length - 3) + " more" : ""));
          body.appendChild(also);
        }
      });
    } else if (sec.kind === "count") {
      var most = sec.rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0);
      sec.rows.forEach(function (r) { body.appendChild(voteRow("", document.createTextNode(r.label), r.count, total, r.count === most)); });
    } else {
      var top = sec.rows.length ? sec.rows[0].count : 0;
      sec.rows.slice(0, 10).forEach(function (r) { body.appendChild(voteRow("", driverNode(r.id), r.count, total, r.count === top)); });
      if (sec.rows.length > 10) { body.appendChild(el("p", "vr-also", "and " + (sec.rows.length - 10) + " more with fewer votes")); }
    }
    box.appendChild(body);
    return box;
  }

  // ---------- one player's card ----------

  function playerCard(uid, type, byUser) {
    var picks = byUser[uid];
    var card = el("section", "sc-section pk-card" + (uid === data.me ? " is-me" : ""));
    var head = document.createElement("header");
    var av = el("span", "pk-av");
    if (P) {
      var a = data.avatars[uid];
      av.innerHTML = P.avatarSvg(a ? a : null, 40, uid);
    }
    head.appendChild(av);
    var h = el("h3", "", data.names[uid] || "Player");
    if (uid === data.me) { h.appendChild(el("span", "you", "(you)")); }
    head.appendChild(h);
    card.appendChild(head);
    var body = el("div", "pk-body");

    function ordered(label, key, size) {
      var listOf = function (p) { return E.list(p, key); };
      var flags = E.onlyPicks(uid, key, "slot", byUser, listOf);
      body.appendChild(el("p", "pk-label", label));
      var ol = el("ol", "pk-ordered");
      listOf(picks).slice(0, size).forEach(function (id, i) {
        var li = document.createElement("li");
        li.appendChild(chip(id, flags[i], "P" + (i + 1)));
        ol.appendChild(li);
      });
      body.appendChild(ol);
    }

    function group(label, ids, flags) {
      body.appendChild(el("p", "pk-label", label));
      var ul = el("ul", "pk-chips");
      ids.forEach(function (id, i) {
        var li = document.createElement("li");
        li.appendChild(chip(id, flags[i]));
        ul.appendChild(li);
      });
      if (ids.length === 0) { ul.appendChild(el("li", "", "None")); }
      body.appendChild(ul);
    }

    if (type === "qualifying" || type === "sprint_qualifying") {
      var q1 = function (p) { return E.list(p, "q1_out"); };
      var q2 = function (p) { return E.list(p, "q2_out"); };
      group("Out in Q1", q1(picks), E.onlyPicks(uid, "q1_out", "any", byUser, q1));
      group("Out in Q2", q2(picks), E.onlyPicks(uid, "q2_out", "any", byUser, q2));
      ordered("Q3 order", "q3_order", 10);
    } else {
      ordered("Top 8", "top8", 8);
      if (type === "race") {
        var flOf = function (p) { return p.fastest_lap ? [p.fastest_lap] : []; };
        group("Fastest lap", flOf(picks), E.onlyPicks(uid, "fl", "any", byUser, flOf));
        var dn = function (p) { return E.dnfList(p); };
        var count = picks.any_dnf ? Number(picks.dnf_count) || 0 : 0;
        group(count === 0 ? "DNFs: none" : "DNFs: " + count, dn(picks), E.onlyPicks(uid, "dnf", "any", byUser, dn));
      }
    }
    card.appendChild(body);
    return card;
  }

  // ---------- page ----------

  function renderSession(byUser) {
    var session = data.sessions[sel.sessionId];
    var type = session.session_type;
    var predictedIds = Object.keys(byUser);
    var allIds = Object.keys(data.names);
    var missing = allIds.filter(function (u) { return !byUser[u]; }).map(function (u) { return data.names[u]; }).sort();

    summaryEl.textContent = "";
    var facts = el("div", "pk-facts");
    var line = el("p");
    line.appendChild(el("b", "", predictedIds.length + " of " + allIds.length));
    line.appendChild(document.createTextNode(" players predicted the " + TYPE_LABEL[type] + ". Picks locked " + when(lockMs(session)) + "."));
    facts.appendChild(line);
    if (missing.length > 0) { facts.appendChild(el("p", "", "No prediction from: " + missing.join(", ") + ".")); }
    var more = el("p");
    if (data.approved[session.id]) {
      more.appendChild(document.createTextNode("The result is in. "));
      var a = el("a", "", "See how it was scored");
      a.href = "scorecard.html?session=" + encodeURIComponent(session.id);
      more.appendChild(a);
      more.appendChild(document.createTextNode("."));
    } else {
      more.textContent = "The score check opens once an admin approves the result.";
    }
    facts.appendChild(more);
    summaryEl.appendChild(facts);
    summaryEl.hidden = false;

    roomEl.textContent = "";
    playersEl.textContent = "";
    if (predictedIds.length === 0) {
      roomEl.appendChild(el("p", "sc-empty", "Nobody predicted this session."));
      roomEl.hidden = false;
      playersEl.hidden = true;
      return;
    }

    var summary = E.summarize(type, byUser);
    roomEl.appendChild(el("h2", "pk-room-title", "The room's view"));
    roomEl.appendChild(el("p", "pk-sub", "The most popular pick for each place. The yellow bar means more than half the room agreed."));
    var grid = el("div", "pk-grid");
    summary.sections.forEach(function (s) { grid.appendChild(roomSection(s, summary.total)); });
    roomEl.appendChild(grid);
    roomEl.hidden = false;

    playersEl.appendChild(el("h2", "pk-room-title", "Everyone's picks"));
    var legend = el("p", "pk-legend");
    var demo = el("span", "chip only", "VER");
    legend.appendChild(demo);
    legend.appendChild(document.createTextNode(" A star marks a pick nobody else made."));
    playersEl.appendChild(legend);
    var cards = el("div", "pk-grid");
    cards.style.marginTop = "14px";
    predictedIds.sort(function (a, b) {
      if (a === data.me) { return -1; }
      if (b === data.me) { return 1; }
      return String(data.names[a]).localeCompare(String(data.names[b]));
    }).forEach(function (u) { cards.appendChild(playerCard(u, type, byUser)); });
    playersEl.appendChild(cards);
    playersEl.hidden = false;
  }

  function loadSession() {
    var my = ++requestId;
    var sid = sel.sessionId;
    summaryEl.hidden = true; roomEl.hidden = true; playersEl.hidden = true;
    setMsg("", "Loading...");
    return client.from("predictions").select("user_id, picks").eq("session_id", sid).then(function (res) {
      if (my !== requestId) { return; }
      if (res.error) { throw res.error; }
      var byUser = {};
      (res.data || []).forEach(function (r) { byUser[r.user_id] = r.picks || {}; });
      setMsg("", "");
      renderSession(byUser);
    }).catch(function (err) {
      console.error(err);
      if (my === requestId) { setMsg("error", "Could not load the picks. Please reload the page. (" + (err.message || "error") + ")"); }
    });
  }

  function fillEvents() {
    eventSel.textContent = "";
    data.events.forEach(function (ev) {
      var o = el("option", "", "Round " + ev.round + " \u00b7 " + ev.name + " (" + ev.season + ")");
      o.value = ev.id;
      eventSel.appendChild(o);
    });
    eventSel.value = sel.eventId;
  }

  function fillTabs() {
    tabsEl.textContent = "";
    sessionsOfEvent(sel.eventId).forEach(function (s) {
      var b = el("button", "sc-tab", TYPE_LABEL[s.session_type] || s.session_type);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-id", s.id);
      var locked = isLocked(s);
      b.disabled = !locked;
      b.setAttribute("aria-selected", s.id === sel.sessionId ? "true" : "false");
      var ms = lockMs(s);
      var small = el("small", "", locked ? (data.approved[s.id] ? "SCORED" : "LOCKED") : (ms ? "HIDDEN UNTIL " + when(ms).toUpperCase() : "TIME TO BE CONFIRMED"));
      b.appendChild(small);
      tabsEl.appendChild(b);
    });
  }

  function chooseEvent(id, wantedSession) {
    sel.eventId = id;
    var list = sessionsOfEvent(id).filter(isLocked);
    var keep = list.some(function (s) { return s.id === (wantedSession || sel.sessionId); });
    sel.sessionId = keep ? (wantedSession || sel.sessionId) : (list.length ? list[list.length - 1].id : null);
    fillEvents();
    fillTabs();
    if (sel.sessionId) { loadSession(); }
  }

  eventSel.addEventListener("change", function () { sel.sessionId = null; chooseEvent(eventSel.value); });
  tabsEl.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".sc-tab") : null;
    if (!b || b.disabled) { return; }
    sel.sessionId = b.getAttribute("data-id");
    fillTabs();
    loadSession();
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && sel.sessionId) { loadSession(); } });

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
      client.from("player_xp").select("user_id, avatar")
    ]).then(function (res) {
      for (var i = 0; i < 5; i++) { if (res[i].error) { throw res[i].error; } }
      (res[0].data || []).forEach(function (s) { data.sessions[s.id] = s; (data.byEvent[s.event_id] = data.byEvent[s.event_id] || []).push(s); });
      var events = (res[1].data || []).sort(function (a, b) { return String(b.start_date).localeCompare(String(a.start_date)); });
      (res[2].data || []).forEach(function (d) { data.drivers[d.id] = d; });
      (res[3].data || []).forEach(function (p) { data.names[p.id] = p.display_name; });
      (res[4].data || []).forEach(function (r) { data.approved[r.session_id] = true; });
      if (!res[5].error) { (res[5].data || []).forEach(function (x) { if (x.avatar) { data.avatars[x.user_id] = x.avatar; } }); }

      data.events = events.filter(function (ev) { return (data.byEvent[ev.id] || []).some(isLocked); });
      if (data.events.length === 0) {
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
      var first = wantEvent && data.events.some(function (e) { return e.id === wantEvent; }) ? wantEvent : data.events[0].id;
      controls.hidden = false;
      chooseEvent(first, wantSession && data.sessions[wantSession] ? wantSession : null);
    });
  }).catch(function (err) {
    console.error(err);
    setMsg("error", "Could not load the picks. Please reload the page. (" + (err.message || "error") + ")");
  });
})();
