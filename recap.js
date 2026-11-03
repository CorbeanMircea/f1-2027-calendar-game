// Lights Out weekend recap on the home page: who won the last finished weekend, who climbed,
// the standout calls and any level-ups. Reads only what group-mates can already see.
(function () {
  "use strict";

  var box = document.getElementById("recap");
  var R = window.LO_RECAP;
  var P = window.LO_PROFILE;
  var client = window.LO_CLIENT; // created by home.js
  if (!box || !R || !client) { return; }

  var TYPE_LABEL = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function ordinal(n) {
    var r = n % 100;
    if (r >= 11 && r <= 13) { return n + "th"; }
    return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function countUp(node, to) {
    node.textContent = String(to);
    if (reducedMotion() || to <= 0) { return; }
    var start = null;
    function frame(t) {
      if (start === null) { start = t; }
      var p = Math.min(1, (t - start) / 900);
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) { window.requestAnimationFrame(frame); }
    }
    window.requestAnimationFrame(frame);
  }

  function avatarBox(size, avatars, uid) {
    var s = el("span", "rc-av");
    s.style.width = size + "px";
    s.style.height = size + "px";
    if (P) { s.innerHTML = P.avatarSvg(avatars[uid] || null, size, uid); }
    return s;
  }

  function card(title) {
    var c = el("div", "rc-card");
    c.appendChild(el("h3", "rc-title", title));
    return c;
  }

  function render(ctx, recap) {
    var names = ctx.names;
    box.textContent = "";
    var inner = el("div", "recap-in");

    var head = el("div", "sec-head");
    var left = document.createElement("div");
    left.appendChild(el("p", "lo-eyebrow", "Weekend recap"));
    left.appendChild(el("h2", "", ctx.event.name));
    head.appendChild(left);
    var link = el("a", "sec-note", "See how it was scored");
    link.href = "scorecard.html?event=" + encodeURIComponent(ctx.event.id);
    head.appendChild(link);
    inner.appendChild(head);

    var grid = el("div", "rc-grid");

    // Winner (or winners on a tie)
    var win = card(recap.winners.length > 1 ? "Weekend winners" : "Weekend winner");
    win.classList.add("rc-winner");
    var points = null;
    recap.winners.forEach(function (w) {
      var row = el("div", "rc-win-row");
      row.appendChild(avatarBox(64, ctx.avatars, w.id));
      var who = el("div", "rc-who");
      who.appendChild(el("strong", "", names[w.id] || "Player"));
      var pt = el("span", "rc-pts");
      var num = el("b", "", "0");
      pt.appendChild(num);
      pt.appendChild(document.createTextNode(" points"));
      who.appendChild(pt);
      points = points || [];
      points.push([num, w.points]);
      row.appendChild(who);
      win.appendChild(row);
    });
    grid.appendChild(win);

    // Podium
    var pod = card("Weekend podium");
    var ol = el("ol", "rc-podium");
    recap.podium.forEach(function (p) {
      var li = document.createElement("li");
      li.appendChild(el("span", "rc-rank", String(p.rank)));
      li.appendChild(avatarBox(32, ctx.avatars, p.id));
      li.appendChild(el("span", "rc-name", names[p.id] || "Player"));
      li.appendChild(el("span", "rc-score", "+" + p.points));
      ol.appendChild(li);
    });
    pod.appendChild(ol);
    grid.appendChild(pod);

    // Highlights and facts
    var hi = card("Highlights");
    var ul = el("ul", "rc-list");
    function add(label, text) {
      var li = document.createElement("li");
      li.appendChild(el("span", "rc-tag", label));
      li.appendChild(document.createTextNode(text));
      ul.appendChild(li);
    }
    if (recap.climber) {
      add("Climber", (names[recap.climber.id] || "Player") + " moved up " + recap.climber.delta + (recap.climber.delta === 1 ? " place" : " places") +
        " to " + ordinal(recap.climber.rankNow) + " in the season.");
    }
    if (recap.best) {
      add("Best score", (names[recap.best.id] || "Player") + " scored " + recap.best.points + " in the " + TYPE_LABEL[recap.best.type] + ".");
    }
    // Players who reached the same level are listed together.
    var byLevel = {};
    recap.levelUps.forEach(function (l) { (byLevel[l.to] = byLevel[l.to] || []).push(names[l.id] || "Player"); });
    Object.keys(byLevel).sort(function (x, y) { return y - x; }).forEach(function (lv) {
      var who = R.joinNames(byLevel[lv].sort());
      add("Level up", who + (byLevel[lv].length > 1 ? " all reached" : " reached") + " Level " + lv + (P ? ", " + P.rankFor(Number(lv)).name : "") + ".");
    });
    recap.facts.forEach(function (f) { add("Call", f); });
    if (!ul.children.length) { ul.appendChild(el("li", "", "A quiet weekend.")); }
    hi.appendChild(ul);
    grid.appendChild(hi);

    inner.appendChild(grid);
    box.appendChild(inner);
    box.hidden = false;

    // Numbers count up when the recap scrolls into view.
    function start() { (points || []).forEach(function (p) { countUp(p[0], p[1]); }); }
    if ("IntersectionObserver" in window && !reducedMotion()) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { io.disconnect(); box.classList.add("in"); start(); }
      }, { threshold: 0.25 });
      io.observe(box);
    } else {
      box.classList.add("in");
      start();
    }
  }

  client.auth.getSession().then(function (r) {
    if (!(r.data && r.data.session)) { return null; }
    return Promise.all([
      client.from("results").select("session_id").eq("status", "approved"),
      client.from("sessions").select("id, event_id, session_type"),
      client.from("events").select("id, name, round, season, start_date"),
      client.from("profiles").select("id, display_name")
    ]).then(function (res) {
      for (var i = 0; i < res.length; i++) { if (res[i].error) { throw res[i].error; } }
      var approved = {};
      (res[0].data || []).forEach(function (x) { approved[x.session_id] = true; });
      var sessions = res[1].data || [];
      var events = (res[2].data || []).slice().sort(function (a, b) { return String(b.start_date).localeCompare(String(a.start_date)); });
      var names = {};
      (res[3].data || []).forEach(function (p) { names[p.id] = p.display_name; });

      // The latest weekend whose race result is approved.
      var event = null;
      for (var e = 0; e < events.length && !event; e++) {
        if (sessions.some(function (s) { return s.event_id === events[e].id && s.session_type === "race" && approved[s.id]; })) { event = events[e]; }
      }
      if (!event) { return null; }
      var eventSessions = sessions.filter(function (s) { return s.event_id === event.id && approved[s.id]; });
      var seasonEvents = {};
      events.forEach(function (ev) { if (ev.season === event.season) { seasonEvents[ev.id] = true; } });
      var seasonSessionIds = sessions.filter(function (s) { return seasonEvents[s.event_id]; }).map(function (s) { return s.id; });
      var ids = eventSessions.map(function (s) { return s.id; });

      return Promise.all([
        client.from("scores").select("user_id, session_id, points").in("session_id", seasonSessionIds),
        client.from("results").select("session_id, data").eq("status", "approved").in("session_id", ids),
        client.from("predictions").select("user_id, session_id, picks").in("session_id", ids),
        client.from("drivers").select("id, code, full_name"),
        client.from("player_xp").select("user_id, avatar, xp")
      ]).then(function (more) {
        for (var i = 0; i < 4; i++) { if (more[i].error) { throw more[i].error; } }
        var results = {};
        (more[1].data || []).forEach(function (x) { results[x.session_id] = x.data; });
        var predictions = {};
        (more[2].data || []).forEach(function (x) { (predictions[x.session_id] = predictions[x.session_id] || {})[x.user_id] = x.picks; });
        var drivers = {};
        (more[3].data || []).forEach(function (d) { drivers[d.id] = d; });
        var avatars = {};
        var xp = {};
        if (!more[4].error) {
          (more[4].data || []).forEach(function (x) { if (x.avatar) { avatars[x.user_id] = x.avatar; } if (typeof x.xp === "number") { xp[x.user_id] = x.xp; } });
        }

        var recap = R.buildRecap({
          names: names, drivers: drivers, eventSessions: eventSessions, seasonSessionIds: seasonSessionIds,
          scores: more[0].data || [], results: results, predictions: predictions, xp: xp,
          levelFor: P ? P.levelFor : null
        });
        if (!recap.hasPoints) { return null; }
        render({ event: event, names: names, avatars: avatars }, recap);
      });
    });
  }).catch(function (err) {
    console.error(err); // the recap is a bonus: never disturb the rest of the page
  });
})();
