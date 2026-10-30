// Lights Out score check: shows how every point of a session score was earned.
// Reads picks, approved results and recorded scores (all already visible to the group),
// recomputes the score with scorecard-engine.js and compares it with the recorded one.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var E = window.LO_SCORING;
  var $ = function (id) { return document.getElementById(id); };
  var msgEl = $("sc-msg");
  var controls = $("sc-controls");
  var eventSel = $("sc-event");
  var playerSel = $("sc-player");
  var tabsEl = $("sc-tabs");
  var resultEl = $("sc-result");
  var everyoneEl = $("sc-everyone");
  var rulesEl = $("sc-rules");
  var rulesBody = $("sc-rules-body");

  var TYPE_LABEL = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };
  var TYPE_ORDER = { sprint_qualifying: 1, sprint: 2, qualifying: 3, race: 4 };

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

  var data = { me: null, drivers: {}, sessions: {}, events: [], results: {}, names: {}, byEvent: {} };
  var sel = { eventId: null, sessionId: null, playerId: null };
  var requestId = 0;

  // ---------- helpers ----------

  function driverNode(id) {
    var d = data.drivers[id];
    var span = el("span", "dr");
    if (!d) { span.appendChild(el("b", "", id || "\u2014")); return span; }
    span.appendChild(el("b", "", d.code));
    var parts = String(d.full_name || "").split(" ");
    span.appendChild(el("i", "", parts.length > 1 ? parts.slice(1).join(" ") : parts[0]));
    return span;
  }

  function cellFor(item, why) {
    var c = document.createElement("div");
    if (item && item.id) { c.appendChild(driverNode(item.id)); }
    else if (item && item.text) { c.appendChild(document.createTextNode(item.text)); }
    else { c.appendChild(document.createTextNode("\u2014")); }
    if (why) { c.appendChild(el("span", "why", why)); }
    return c;
  }

  function playerName(id) {
    return (data.names[id] || "Player") + (id === data.me ? " (you)" : "");
  }

  function sessionsOfEvent(eventId) {
    return (data.byEvent[eventId] || []).slice().sort(function (a, b) {
      return (TYPE_ORDER[a.session_type] || 9) - (TYPE_ORDER[b.session_type] || 9);
    });
  }

  // ---------- selectors ----------

  function fillEvents() {
    eventSel.textContent = "";
    data.events.forEach(function (ev) {
      var o = el("option", "", "Round " + ev.round + " \u00b7 " + ev.name + " (" + ev.season + ")");
      o.value = ev.id;
      eventSel.appendChild(o);
    });
    eventSel.value = sel.eventId;
  }

  function fillPlayers() {
    playerSel.textContent = "";
    var ids = Object.keys(data.names).sort(function (a, b) {
      if (a === data.me) { return -1; }
      if (b === data.me) { return 1; }
      return String(data.names[a]).localeCompare(String(data.names[b]));
    });
    ids.forEach(function (id) {
      var o = el("option", "", playerName(id));
      o.value = id;
      playerSel.appendChild(o);
    });
    playerSel.value = sel.playerId;
  }

  function fillTabs() {
    tabsEl.textContent = "";
    sessionsOfEvent(sel.eventId).forEach(function (s) {
      var b = el("button", "sc-tab", TYPE_LABEL[s.session_type] || s.session_type);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-id", s.id);
      b.setAttribute("aria-selected", s.id === sel.sessionId ? "true" : "false");
      tabsEl.appendChild(b);
    });
  }

  // ---------- rendering ----------

  function sectionNode(sec) {
    var box = el("section", "sc-section");
    var head = document.createElement("header");
    head.appendChild(el("h3", "", sec.title));
    head.appendChild(el("span", "sc-sub", "+" + sec.subtotal));
    box.appendChild(head);
    if (sec.note) { box.appendChild(el("p", "sc-note", sec.note)); }

    var list = el("ol", "sc-rows");
    list.style.listStyle = "none";
    var h = el("li", "sc-row sc-head");
    ["", "Your pick", "What happened", "Pts"].forEach(function (t, i) {
      var s = el("span", "", t);
      if (i === 3) { s.style.textAlign = "right"; }
      h.appendChild(s);
    });
    list.appendChild(h);

    sec.rows.forEach(function (r) {
      var li = el("li", "sc-row " + r.state);
      li.appendChild(el("span", "sc-pos", r.label));
      var pick = el("div", "sc-pick");
      var mark = el("span", "sc-mark", r.state === "hit" ? "\u2713" : (r.state === "part" ? "~" : "\u2717"));
      mark.setAttribute("aria-label", r.state === "hit" ? "Correct" : (r.state === "part" ? "Partly correct" : "Not correct"));
      pick.appendChild(mark);
      pick.appendChild(cellFor(r.pick, ""));
      if (r.pickWhy) { pick.appendChild(el("span", "why", r.pickWhy)); }
      li.appendChild(pick);
      var act = el("div", "sc-actual");
      if (r.actual) { act.appendChild(cellFor(r.actual, r.actualWhy)); }
      else if (r.actualWhy) { act.appendChild(document.createTextNode(r.actualWhy)); }
      li.appendChild(act);
      li.appendChild(el("span", "sc-pts", r.points > 0 ? "+" + r.points : "0"));
      list.appendChild(li);
    });
    box.appendChild(list);

    if (sec.actualList) {
      var line = el("p", "sc-note");
      line.style.paddingBottom = "12px";
      line.appendChild(document.createTextNode(sec.actualText || "Actual: "));
      if (sec.actualList.length === 0) { line.appendChild(document.createTextNode("none")); }
      sec.actualList.forEach(function (id, i) {
        if (i > 0) { line.appendChild(document.createTextNode(", ")); }
        var d = data.drivers[id];
        line.appendChild(document.createTextNode(d ? d.code : id));
      });
      box.appendChild(line);
    }
    return box;
  }

  function comparisonNode(calc, recorded) {
    var wrap = el("div", "sc-wrap");
    var table = el("table", "sc-table");
    var head = document.createElement("tr");
    ["Part of the score", "Calculated here", "Recorded by the site", ""].forEach(function (t) { head.appendChild(el("th", "", t)); });
    table.appendChild(head);

    var allSame = true;
    Object.keys(calc.components).forEach(function (k) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "", E.LABELS[k] || k));
      tr.appendChild(el("td", "", String(calc.components[k])));
      var rec = recorded ? recorded.breakdown[k] : undefined;
      tr.appendChild(el("td", "", rec === undefined ? "\u2014" : String(rec)));
      var same = rec === calc.components[k];
      if (!same) { allSame = false; }
      tr.appendChild(el("td", same ? "good" : "bad", same ? "\u2713" : "differs"));
      table.appendChild(tr);
    });

    var tot = document.createElement("tr");
    tot.className = "total";
    tot.appendChild(el("td", "", "Total"));
    tot.appendChild(el("td", "", String(calc.total)));
    tot.appendChild(el("td", "", recorded ? String(recorded.points) : "\u2014"));
    var totalSame = !!recorded && recorded.points === calc.total;
    if (!totalSame) { allSame = false; }
    tot.appendChild(el("td", totalSame ? "good" : "bad", totalSame ? "\u2713" : "differs"));
    table.appendChild(tot);
    wrap.appendChild(table);
    return { node: wrap, same: allSame };
  }

  function renderRules(type) {
    rulesBody.textContent = "";
    var items = {
      qualifying: ["<b>Knocked out in Q1 and Q2:</b> 1 point for each driver you picked who really went out in that part.",
        "<b>Q3 order (P1 to P10):</b> 1 point for each driver who reached Q3, plus 3 more if he is in the exact position.",
        "<b>Perfect Q3 order:</b> +10 bonus if all ten positions are exactly right."],
      race: ["<b>Top 8:</b> 5 points for an exact position, 2 points for a top-8 driver in another place, +15 bonus for a perfect top 8.",
        "<b>Fastest lap:</b> 3 points.",
        "<b>Any DNF:</b> 2 points if you were right about whether anyone retires.",
        "<b>Number of DNFs:</b> 5 points if exact, 2 if off by one.",
        "<b>DNF drivers:</b> for each driver you picked who retires, 4 points, or 8 if he started in the real top 8."],
      sprint: ["<b>Top 8:</b> 3 points for an exact position, 1 point for a top-8 driver in another place, +8 bonus for a perfect top 8."]
    };
    var key = type === "sprint_qualifying" ? "qualifying" : type;
    var ul = document.createElement("ul");
    (items[key] || items.race).forEach(function (t) { var li = document.createElement("li"); li.innerHTML = t; ul.appendChild(li); });
    rulesBody.appendChild(ul);
    rulesEl.hidden = false;
  }

  function renderPlayer(ctx) {
    resultEl.textContent = "";
    var type = data.sessions[sel.sessionId].session_type;
    var actual = data.results[sel.sessionId];
    var pred = ctx.predictions[sel.playerId];
    var recorded = ctx.scores[sel.playerId] || null;

    var sum = el("div", "sc-summary");
    var a = el("div"); a.appendChild(el("div", "sc-label", "Player")); a.appendChild(el("p", "sc-who", playerName(sel.playerId)));
    var b = el("div"); b.appendChild(el("div", "sc-label", "Session")); b.appendChild(el("p", "sc-who", TYPE_LABEL[type]));
    var c = el("div"); c.appendChild(el("div", "sc-label", "Points recorded")); c.appendChild(el("p", "sc-big", recorded ? String(recorded.points) : "0"));
    sum.appendChild(a); sum.appendChild(b); sum.appendChild(c);
    resultEl.appendChild(sum);

    if (!pred) {
      resultEl.appendChild(el("p", "sc-check none", recorded && recorded.points > 0
        ? "No prediction is visible for this player, but " + recorded.points + " points are recorded. Ask the admin to check."
        : "This player made no prediction for this session, so there are no points."));
      renderRules(type);
      return;
    }

    var calc = E.explain(type, pred, actual);
    var cmp = comparisonNode(calc, recorded);

    if (!recorded) {
      resultEl.appendChild(el("p", "sc-check bad", "Calculated total: " + calc.total + " points, but no score is recorded yet for this player."));
    } else if (cmp.same) {
      resultEl.appendChild(el("p", "sc-check ok", "The score calculated here (" + calc.total + ") matches the score recorded by the site."));
    } else {
      resultEl.appendChild(el("p", "sc-check bad", "The score calculated here (" + calc.total + ") does not match the recorded score (" + recorded.points + "). Tell the admin."));
    }

    calc.sections.forEach(function (s) { resultEl.appendChild(sectionNode(s)); });

    var totals = el("section", "sc-section");
    var th = document.createElement("header");
    th.appendChild(el("h3", "", "Adding it up"));
    th.appendChild(el("span", "sc-sub", String(calc.total)));
    totals.appendChild(th);
    totals.appendChild(cmp.node);
    resultEl.appendChild(totals);

    renderRules(type);
  }

  function renderEveryone(ctx) {
    everyoneEl.textContent = "";
    var type = data.sessions[sel.sessionId].session_type;
    var actual = data.results[sel.sessionId];
    var ids = Object.keys(data.names).sort(function (x, y) { return String(data.names[x]).localeCompare(String(data.names[y])); });

    var box = el("section", "sc-section");
    var head = document.createElement("header");
    head.appendChild(el("h3", "", "Everyone in this session"));
    box.appendChild(head);
    var wrap = el("div", "sc-wrap");
    var table = el("table", "sc-table");
    var hr = document.createElement("tr");
    ["Player", "Calculated", "Recorded", ""].forEach(function (t) { hr.appendChild(el("th", "", t)); });
    table.appendChild(hr);

    var mismatches = 0;
    ids.forEach(function (id) {
      var pred = ctx.predictions[id];
      var rec = ctx.scores[id];
      var calc = pred ? E.explain(type, pred, actual).total : 0;
      var recPts = rec ? rec.points : 0;
      var same = calc === recPts;
      if (!same) { mismatches++; }
      var tr = document.createElement("tr");
      var nameCell = document.createElement("td");
      var btn = el("button", "", playerName(id));
      btn.type = "button";
      btn.setAttribute("data-player", id);
      nameCell.appendChild(btn);
      tr.appendChild(nameCell);
      tr.appendChild(el("td", "", pred ? String(calc) : "no prediction"));
      tr.appendChild(el("td", "", rec ? String(recPts) : "0"));
      tr.appendChild(el("td", same ? "good" : "bad", same ? "\u2713" : "differs"));
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    box.appendChild(wrap);
    if (mismatches > 0) {
      box.appendChild(el("p", "sc-check bad", mismatches + (mismatches === 1 ? " player has" : " players have") +
        " a calculated score that differs from the recorded one. Open that player to see which part."));
    }
    everyoneEl.appendChild(box);
  }

  // ---------- loading ----------

  function loadSession() {
    var my = ++requestId;
    var sid = sel.sessionId;
    resultEl.hidden = true;
    everyoneEl.hidden = true;
    setMsg("", "Loading...");

    return Promise.all([
      client.from("predictions").select("user_id, picks").eq("session_id", sid),
      client.from("scores").select("user_id, points, breakdown").eq("session_id", sid)
    ]).then(function (res) {
      if (my !== requestId) { return; }
      if (res[0].error) { throw res[0].error; }
      if (res[1].error) { throw res[1].error; }
      var ctx = { predictions: {}, scores: {} };
      (res[0].data || []).forEach(function (p) { ctx.predictions[p.user_id] = p.picks; });
      (res[1].data || []).forEach(function (s) { ctx.scores[s.user_id] = s; });
      setMsg("", "");
      renderPlayer(ctx);
      renderEveryone(ctx);
      resultEl.hidden = false;
      everyoneEl.hidden = false;
    }).catch(function (err) {
      console.error(err);
      if (my === requestId) { setMsg("error", "Could not load this session. Please reload the page. (" + (err.message || "error") + ")"); }
    });
  }

  function chooseEvent(id) {
    sel.eventId = id;
    var list = sessionsOfEvent(id);
    var keep = list.some(function (s) { return s.id === sel.sessionId; });
    if (!keep) {
      sel.sessionId = list.length ? list[list.length - 1].id : null; // latest session of the weekend
    }
    fillEvents();
    fillTabs();
    if (sel.sessionId) { loadSession(); }
  }

  eventSel.addEventListener("change", function () { chooseEvent(eventSel.value); });
  playerSel.addEventListener("change", function () { sel.playerId = playerSel.value; loadSession(); });
  tabsEl.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".sc-tab") : null;
    if (!b) { return; }
    sel.sessionId = b.getAttribute("data-id");
    fillTabs();
    loadSession();
  });
  everyoneEl.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button[data-player]") : null;
    if (!b) { return; }
    sel.playerId = b.getAttribute("data-player");
    playerSel.value = sel.playerId;
    loadSession().then(function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
  });

  // ---------- start ----------

  client.auth.getSession().then(function (r) {
    var session = r.data && r.data.session;
    if (!session) {
      setMsg("", "Sign in to see the score check.");
      msgEl.innerHTML = "";
      msgEl.appendChild(document.createTextNode("Sign in on the "));
      var a = el("a", "", "Account page");
      a.href = "account.html";
      msgEl.appendChild(a);
      msgEl.appendChild(document.createTextNode(" to see the score check."));
      return null;
    }
    data.me = session.user.id;
    setMsg("", "Loading...");

    return Promise.all([
      client.from("results").select("session_id, data").eq("status", "approved"),
      client.from("sessions").select("id, event_id, session_type"),
      client.from("events").select("id, name, round, season, start_date"),
      client.from("drivers").select("id, code, full_name"),
      client.from("profiles").select("id, display_name")
    ]).then(function (res) {
      for (var i = 0; i < res.length; i++) { if (res[i].error) { throw res[i].error; } }
      (res[0].data || []).forEach(function (r) { data.results[r.session_id] = r.data; });
      (res[1].data || []).forEach(function (s) { if (data.results[s.id]) { data.sessions[s.id] = s; (data.byEvent[s.event_id] = data.byEvent[s.event_id] || []).push(s); } });
      data.events = (res[2].data || []).filter(function (ev) { return data.byEvent[ev.id]; })
        .sort(function (a, b) { return String(b.start_date).localeCompare(String(a.start_date)); });
      (res[3].data || []).forEach(function (d) { data.drivers[d.id] = d; });
      (res[4].data || []).forEach(function (p) { data.names[p.id] = p.display_name; });

      if (data.events.length === 0) {
        setMsg("", "No results have been approved yet. Once an admin approves a result, you can see exactly how it was scored here.");
        return;
      }

      var params = new URLSearchParams(window.location.search);
      var wantPlayer = params.get("player");
      sel.playerId = wantPlayer && data.names[wantPlayer] ? wantPlayer : (data.names[data.me] ? data.me : Object.keys(data.names)[0]);
      var wantEvent = params.get("event");
      var firstEvent = wantEvent && data.byEvent[wantEvent] ? wantEvent : data.events[0].id;
      var wantSession = params.get("session");
      sel.sessionId = wantSession && data.sessions[wantSession] ? wantSession : null;
      if (wantSession && data.sessions[wantSession]) { firstEvent = data.sessions[wantSession].event_id; }

      fillPlayers();
      controls.hidden = false;
      chooseEvent(firstEvent);
    });
  }).catch(function (err) {
    console.error(err);
    setMsg("error", "Could not load the score check. Please reload the page. (" + (err.message || "error") + ")");
  });
})();
