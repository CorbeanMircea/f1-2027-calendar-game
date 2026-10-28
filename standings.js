(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};

  function byId(id) { return document.getElementById(id); }

  var messageEl = byId("board-message");
  var gate = byId("gate");
  var gateText = byId("gate-text");
  var boardPanel = byId("board-panel");
  var seasonField = byId("season-field");
  var seasonSelect = byId("season-select");
  var liveBadge = byId("live-badge");
  var updatedEl = byId("updated");
  var emptyText = byId("empty-text");
  var wrapEl = byId("standings-wrap");
  var listEl = byId("standings");

  var TYPE_LABEL = {
    sprint_qualifying: "Sprint Qualifying",
    sprint: "Sprint",
    qualifying: "Qualifying",
    race: "Race"
  };

  var user = null;
  var currentSeason = null;
  var refreshTimer = null;
  var channel = null;
  var expanded = {};
  var lastPoints = {};

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function setShown(node, on) { node.hidden = !on; }

  function showGate(text) {
    gateText.textContent = text;
    setShown(gate, true);
    setShown(boardPanel, false);
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    setMessage("error", "Site configuration is incomplete.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function seasonLabel(season) {
    if (season === 9999) { return "Practice (test)"; }
    return season + " season" + (season < 2027 ? " (rehearsal)" : "");
  }

  function setLive(status) {
    if (status === "SUBSCRIBED") {
      liveBadge.className = "live-badge live";
      liveBadge.textContent = "Live";
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      liveBadge.className = "live-badge";
      liveBadge.textContent = "Offline - updates when you return to this tab";
    } else {
      liveBadge.className = "live-badge";
      liveBadge.textContent = "Connecting...";
    }
  }

  // ---------- data ----------

  function loadModel(season) {
    var model = { events: [], sessionInfo: {}, scores: [], names: {}, extras: {} };

    return client.from("events").select("id, name, round, start_date")
      .eq("season", season).order("start_date", { ascending: true })
      .then(function (r) {
        if (r.error) { throw r.error; }
        model.events = r.data || [];
        var ids = model.events.map(function (e) { return e.id; });
        if (ids.length === 0) { return { data: [] }; }
        return client.from("sessions").select("id, event_id, session_type").in("event_id", ids);
      })
      .then(function (r) {
        if (r.error) { throw r.error; }
        var sessionIds = [];
        (r.data || []).forEach(function (s) {
          model.sessionInfo[s.id] = { event_id: s.event_id, session_type: s.session_type };
          sessionIds.push(s.id);
        });
        if (sessionIds.length === 0) { return { data: [] }; }
        return client.from("scores").select("user_id, session_id, points").in("session_id", sessionIds);
      })
      .then(function (r) {
        if (r.error) { throw r.error; }
        model.scores = r.data || [];
        return client.from("profiles").select("id, display_name");
      })
      .then(function (r) {
        if (r.error) { throw r.error; }
        (r.data || []).forEach(function (p) { model.names[p.id] = p.display_name; });
        // Avatars and levels (database update 019). Missing view: the board still works.
        return client.from("player_xp").select("user_id, avatar, xp").then(function (x) {
          if (!x.error) { (x.data || []).forEach(function (p) { model.extras[p.user_id] = p; }); }
          return model;
        }, function () { return model; });
      });
  }

  function buildModel(model) {
    var weekendMap = {};
    model.scores.forEach(function (s) {
      var info = model.sessionInfo[s.session_id];
      if (!info) { return; }
      var weekend = weekendMap[info.event_id] || (weekendMap[info.event_id] = {});
      var rec = weekend[s.user_id] || (weekend[s.user_id] = { total: 0, parts: [] });
      rec.total += s.points;
      rec.parts.push({ type: info.session_type, points: s.points });
    });

    var weekends = model.events.filter(function (e) { return weekendMap[e.id]; });
    var playerIds = Object.keys(model.names);

    function standingsUpTo(count) {
      var rows = playerIds.map(function (id) {
        var points = 0;
        for (var i = 0; i < count; i++) {
          var rec = weekendMap[weekends[i].id][id];
          if (rec) { points += rec.total; }
        }
        return { id: id, name: model.names[id], points: points };
      });
      rows.sort(function (a, b) {
        if (b.points !== a.points) { return b.points - a.points; }
        return a.name < b.name ? -1 : 1;
      });
      var rank = 0;
      var previous = null;
      rows.forEach(function (row, index) {
        if (row.points !== previous) { rank = index + 1; previous = row.points; }
        row.rank = rank;
      });
      return rows;
    }

    var current = standingsUpTo(weekends.length);
    var previousRows = weekends.length >= 2 ? standingsUpTo(weekends.length - 1) : null;
    var previousRank = {};
    if (previousRows) { previousRows.forEach(function (r) { previousRank[r.id] = r.rank; }); }

    var last = weekends.slice(-5);
    var bestOf = last.map(function (w) {
      var best = 0;
      playerIds.forEach(function (id) {
        var rec = weekendMap[w.id][id];
        if (rec && rec.total > best) { best = rec.total; }
      });
      return best;
    });

    current.forEach(function (row) {
      row.move = previousRows && previousRank[row.id] !== undefined ? previousRank[row.id] - row.rank : null;
      row.bars = last.map(function (w, i) {
        var rec = weekendMap[w.id][row.id];
        var points = rec ? rec.total : 0;
        return {
          points: points,
          best: points > 0 && points === bestOf[i],
          height: bestOf[i] > 0 ? Math.round((points / bestOf[i]) * 100) : 0
        };
      });
      row.detail = weekends.slice().reverse().map(function (w) {
        var rec = weekendMap[w.id][row.id];
        return { name: w.name, points: rec ? rec.total : 0, parts: rec ? rec.parts : [] };
      });
    });

    return { rows: current, hasScores: weekends.length > 0, extras: model.extras };
  }

  // ---------- rendering ----------

  var firstPaint = true;

  function countUp(node, from, to) {
    node.textContent = String(to);
    if (reducedMotion() || from === to) { return; }
    var start = null;
    function frame(t) {
      if (start === null) { start = t; }
      var p = Math.min(1, (t - start) / 800);
      node.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) { window.requestAnimationFrame(frame); }
    }
    window.requestAnimationFrame(frame);
  }

  function renderRow(row, extras, leaderPoints) {
    var rankClass = row.rank <= 3 ? "rank-" + row.rank : "rank-n";
    var li = el("li", "standing " + rankClass + (row.id === user.id ? " is-me" : ""));
    li.setAttribute("data-id", row.id);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "standing-row";
    btn.setAttribute("aria-expanded", expanded[row.id] ? "true" : "false");

    btn.appendChild(el("span", "pos", String(row.rank)));

    var P = window.LO_PROFILE;
    var extra = extras[row.id];
    var av = el("span", "av");
    if (P) { av.innerHTML = P.avatarSvg(extra && extra.avatar ? extra.avatar : null, 52, row.id); }
    btn.appendChild(av);

    var name = el("span", "name");
    var top = el("span", "name-top");
    if (P && extra && typeof extra.xp === "number") {
      var lvl = P.levelFor(extra.xp).level;
      var badge = el("span", "nb");
      badge.innerHTML = P.badgeSvg(P.tierFor(lvl), 16);
      top.appendChild(badge);
    }
    top.appendChild(el("span", "n", row.name));
    if (row.id === user.id) { top.appendChild(el("span", "you", "(you)")); }
    if (P && extra && typeof extra.xp === "number") {
      top.appendChild(el("span", "lv", "LV " + P.levelFor(extra.xp).level));
    }
    name.appendChild(top);
    var gap = leaderPoints - row.points;
    name.appendChild(el("span", "sub", row.rank === 1 ? "Leader" : (gap === 0 ? "Level on points" : gap + " behind the leader")));
    btn.appendChild(name);

    var meta = el("span", "meta");
    var move;
    if (row.move === null || row.move === 0) {
      move = el("span", "move same", "\u2013");
    } else if (row.move > 0) {
      move = el("span", "move up", String(row.move));
    } else {
      move = el("span", "move down", String(-row.move));
    }
    meta.appendChild(move);

    var bars = el("span", "last5");
    var summary = [];
    row.bars.forEach(function (b) {
      var bar = el("span", "bar" + (b.points === 0 ? " none" : "") + (b.best ? " best" : ""));
      bar.style.height = (b.points === 0 ? 12 : Math.max(b.height, 12)) + "%";
      bars.appendChild(bar);
      summary.push(b.points);
    });
    bars.setAttribute("role", "img");
    bars.setAttribute("aria-label", summary.length ? "Last weekends: " + summary.join(", ") + " points" : "No weekends yet");
    meta.appendChild(bars);
    btn.appendChild(meta);

    var pts = el("span", "points", String(row.points));
    pts.setAttribute("data-points", String(row.points));
    btn.appendChild(pts);
    li.appendChild(btn);

    var detail = el("div", "detail");
    detail.hidden = !expanded[row.id];
    var list = el("ul", "");
    row.detail.forEach(function (w) {
      var item = document.createElement("li");
      item.appendChild(el("span", "w-name", w.name));
      var parts = w.parts.map(function (p) { return (TYPE_LABEL[p.type] || p.type) + " " + p.points; }).join(", ");
      item.appendChild(el("span", "w-points", w.points + " points" + (parts ? " (" + parts + ")" : "")));
      list.appendChild(item);
    });
    detail.appendChild(list);
    li.appendChild(detail);

    btn.addEventListener("click", function () {
      expanded[row.id] = !expanded[row.id];
      btn.setAttribute("aria-expanded", expanded[row.id] ? "true" : "false");
      detail.hidden = !expanded[row.id];
    });

    return li;
  }

  function render(built, animate) {
    var before = {};
    var animateRows = animate && !reducedMotion();
    if (animateRows) {
      Array.prototype.forEach.call(listEl.children, function (li) {
        before[li.getAttribute("data-id")] = li.getBoundingClientRect().top;
      });
    }

    listEl.textContent = "";
    var leaderPoints = built.rows.length ? built.rows[0].points : 0;
    built.rows.forEach(function (row) {
      var li = renderRow(row, built.extras || {}, leaderPoints);
      var from = lastPoints[row.id] !== undefined ? lastPoints[row.id] : 0;
      if (firstPaint || lastPoints[row.id] !== undefined) {
        countUp(li.querySelector(".points"), firstPaint ? 0 : from, row.points);
      }
      if (animate && lastPoints[row.id] !== undefined && lastPoints[row.id] !== row.points) {
        li.classList.add("is-updated");
        window.setTimeout(function () { li.classList.remove("is-updated"); }, 2500);
      }
      listEl.appendChild(li);
    });

    if (animateRows) {
      Array.prototype.forEach.call(listEl.children, function (li) {
        var id = li.getAttribute("data-id");
        if (before[id] === undefined) { return; }
        var delta = before[id] - li.getBoundingClientRect().top;
        if (Math.abs(delta) < 1) { return; }
        li.style.transition = "none";
        li.style.transform = "translateY(" + delta + "px)";
        li.getBoundingClientRect();
        li.style.transition = "transform 350ms ease";
        li.style.transform = "";
        window.setTimeout(function () { li.style.transition = ""; }, 400);
      });
    }

    lastPoints = {};
    built.rows.forEach(function (row) { lastPoints[row.id] = row.points; });
    firstPaint = false;
  }

  function refresh(animate) {
    return loadModel(currentSeason).then(function (model) {
      var built = buildModel(model);
      if (!built.hasScores) {
        setShown(wrapEl, false);
        setShown(emptyText, true);
        updatedEl.textContent = "";
        return;
      }
      setShown(emptyText, false);
      setShown(wrapEl, true);
      render(built, animate);
      updatedEl.textContent = "Updated " +
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    });
  }

  function loadSeasons() {
    return client.from("leaderboard").select("season").then(function (result) {
      if (result.error) { throw result.error; }

      var seen = {};
      var seasons = [];
      (result.data || []).forEach(function (row) {
        if (!seen[row.season]) { seen[row.season] = true; seasons.push(row.season); }
      });

      if (seasons.length === 0) {
        setShown(seasonField, false);
        setShown(wrapEl, false);
        setShown(emptyText, true);
        updatedEl.textContent = "";
        currentSeason = null;
        return;
      }

      seasons.sort(function (a, b) {
        if (a === 9999) { return 1; }
        if (b === 9999) { return -1; }
        return b - a;
      });

      seasonSelect.textContent = "";
      seasons.forEach(function (season) {
        var opt = document.createElement("option");
        opt.value = String(season);
        opt.textContent = seasonLabel(season);
        seasonSelect.appendChild(opt);
      });

      if (currentSeason === null || !seen[currentSeason]) { currentSeason = seasons[0]; }
      seasonSelect.value = String(currentSeason);
      setShown(seasonField, true);
    });
  }

  function handleError(err) {
    console.error(err);
    setMessage("error", "Could not load the leaderboard. Please reload the page.");
  }

  function refreshAll(animate) {
    return loadSeasons().then(function () {
      if (currentSeason === null) { return; }
      return refresh(animate);
    });
  }

  function scheduleRefresh() {
    if (refreshTimer) { window.clearTimeout(refreshTimer); }
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      refreshAll(true).then(function () { setMessage("", ""); }).catch(handleError);
    }, 600);
  }

  seasonSelect.addEventListener("change", function () {
    currentSeason = Number(seasonSelect.value);
    expanded = {};
    lastPoints = {};
    firstPaint = true;
    refresh(false).catch(handleError);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && user) { scheduleRefresh(); }
  });

  function startRealtime() {
    setLive("CONNECTING");
    channel = client.channel("scores-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, scheduleRefresh)
      .subscribe(function (status) { setLive(status); });
  }

  window.addEventListener("pagehide", function () {
    if (channel) { client.removeChannel(channel); }
  });

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) {
      showGate("Please sign in on the Account page to see the leaderboard.");
      return;
    }
    user = session.user;

    return client.from("group_members").select("group_id").eq("user_id", user.id).limit(1)
      .then(function (membership) {
        if (membership.error) { throw membership.error; }
        if (!membership.data || membership.data.length === 0) {
          showGate("Join the friends group on the Account page first.");
          return;
        }
        setShown(gate, false);
        setShown(boardPanel, true);
        startRealtime();
        return refreshAll(false);
      });
  }).catch(handleError);
})();