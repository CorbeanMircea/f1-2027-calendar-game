(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var heroBox = document.getElementById("hero-content");
  var scheduleBox = document.getElementById("schedule-rows");
  var standingsBox = document.getElementById("standings-rows");
  var seasonNote = document.getElementById("standings-season");
  if (!heroBox || !scheduleBox || !standingsBox) { return; }

  var TYPE_LABEL = {
    sprint_qualifying: "Sprint Qualifying",
    sprint: "Sprint",
    qualifying: "Qualifying",
    race: "Race"
  };
  // Which qualifying session locks the predictions for each session type.
  var LOCK_TYPE = {
    qualifying: "qualifying",
    race: "qualifying",
    sprint_qualifying: "sprint_qualifying",
    sprint: "sprint_qualifying"
  };
  var PALETTE = ["#ff8000", "#3671c6", "#27f4d2", "#e8002d", "#229971",
                 "#ff87bc", "#64c4ff", "#6692ff", "#b6babd", "#f5c400"];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function makeLink(className, href, text) {
    var a = el("a", className, text);
    a.href = href;
    return a;
  }

  function showHeroMessage(text) {
    heroBox.textContent = "";
    heroBox.appendChild(el("p", "placeholder", text));
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    showHeroMessage("Site configuration is incomplete.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

  function parseDay(isoDate) {
    return new Date(isoDate + "T00:00:00Z");
  }

  function formatRange(startIso, endIso) {
    var a = parseDay(startIso);
    var b = parseDay(endIso);
    var aMonth = monthFormat.format(a);
    var bMonth = monthFormat.format(b);
    var year = b.getUTCFullYear();
    if (aMonth === bMonth) {
      return a.getUTCDate() + "\u2013" + b.getUTCDate() + " " + aMonth + " " + year;
    }
    return a.getUTCDate() + " " + aMonth + " \u2013 " + b.getUTCDate() + " " + bMonth + " " + year;
  }

  function whenText(iso) {
    return new Date(iso).toLocaleString([], {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function colorFor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return PALETTE[hash % PALETTE.length];
  }

  var current = { ev: null, sessions: [], mine: {}, signedIn: false, userId: null };
  var clockNode = null;
  var lastSignature = "";

  function msOf(session) {
    return Date.parse(session.start_utc);
  }

  function timedSessions() {
    return current.sessions
      .filter(function (s) { return s.start_utc; })
      .sort(function (a, b) { return msOf(a) - msOf(b); });
  }

  function lockTimeFor(session) {
    var lockType = LOCK_TYPE[session.session_type];
    for (var i = 0; i < current.sessions.length; i++) {
      var s = current.sessions[i];
      if (s.session_type === lockType && s.start_utc) { return msOf(s); }
    }
    return null;
  }

  // open: more than 24 h to the next lock; soon: less than 24 h; locked: all locks have passed.
  function computeState(now) {
    var timed = timedSessions();
    if (timed.length === 0) { return { kind: "tbc", signature: "tbc" }; }

    var locks = timed.filter(function (s) {
      return s.session_type === "qualifying" || s.session_type === "sprint_qualifying";
    });
    for (var i = 0; i < locks.length; i++) {
      if (msOf(locks[i]) > now) {
        var remaining = msOf(locks[i]) - now;
        var kind = remaining < 86400000 ? "soon" : "open";
        return { kind: kind, session: locks[i], remaining: remaining, signature: kind + locks[i].id };
      }
    }
    for (var j = 0; j < timed.length; j++) {
      if (msOf(timed[j]) > now) {
        return {
          kind: "locked", session: timed[j],
          remaining: msOf(timed[j]) - now, signature: "locked" + timed[j].id
        };
      }
    }
    return { kind: "locked", session: null, remaining: 0, signature: "finished" };
  }

  function fillClock(node, ms) {
    node.textContent = "";
    var minutes = Math.max(0, Math.floor(ms / 60000));
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    var mins = minutes % 60;

    var parts = [];
    if (days > 0) { parts.push([String(days), days === 1 ? "day" : "days"]); }
    if (days > 0 || hours > 0) { parts.push([pad2(hours), hours === 1 ? "hour" : "hours"]); }
    parts.push([pad2(mins), mins === 1 ? "minute" : "minutes"]);

    parts.forEach(function (p) {
      var group = el("span", "unit");
      group.appendChild(el("span", "num", p[0]));
      group.appendChild(el("span", "unit-label", p[1]));
      node.appendChild(group);
    });
  }

  function renderHero() {
    var ev = current.ev;
    var state = computeState(Date.now());
    lastSignature = state.signature;
    clockNode = null;
    heroBox.textContent = "";

    var mark = el("p", "round-mark", String(ev.round));
    mark.setAttribute("aria-hidden", "true");
    heroBox.appendChild(mark);

    heroBox.appendChild(el("p", "hero-place", ev.locality + ", " + ev.country));
    heroBox.appendChild(el("h1", "hero-title", ev.name));
    heroBox.appendChild(el("p", "hero-dates",
      formatRange(ev.start_date, ev.end_date) + ", " + ev.circuit + (ev.has_sprint ? " (sprint weekend)" : "")));

    var lock = el("div", "lock");
    lock.setAttribute("data-state", state.kind);

    if (state.kind === "tbc") {
      lock.appendChild(el("p", "lock-label", "Session times"));
      var tbc = el("p", "clock");
      tbc.appendChild(el("span", "num word", "To be confirmed"));
      lock.appendChild(tbc);
      lock.appendChild(el("p", "lock-detail", "Predictions open once the official schedule is published."));
    } else if (!state.session) {
      lock.appendChild(el("p", "lock-label", "This weekend"));
      var fin = el("p", "clock");
      fin.appendChild(el("span", "num word", "Finished"));
      lock.appendChild(fin);
      lock.appendChild(el("p", "lock-detail",
        "Predictions are locked. Points appear on the leaderboard after an admin approves each result."));
    } else {
      var label = state.kind === "locked"
        ? TYPE_LABEL[state.session.session_type] + " starts in"
        : "Predictions lock in";
      lock.appendChild(el("p", "lock-label", label));
      var clock = el("p", "clock");
      clock.setAttribute("role", "timer");
      fillClock(clock, state.remaining);
      clockNode = clock;
      lock.appendChild(clock);
      lock.appendChild(el("p", "lock-detail", state.kind === "locked"
        ? "Predictions are locked. Points appear on the leaderboard after an admin approves each result."
        : "Locks when " + TYPE_LABEL[state.session.session_type] + " starts, " +
          whenText(state.session.start_utc) + " (your time)."));
    }
    heroBox.appendChild(lock);

    var actions = el("div", "hero-actions");
    if (!current.signedIn) {
      actions.appendChild(makeLink("btn btn-primary", "account.html", "Sign in or create an account"));
    } else if (state.kind === "open" || state.kind === "soon") {
      actions.appendChild(makeLink("btn btn-primary", "predict.html", "Make your predictions"));
      actions.appendChild(makeLink("btn", "leaderboard.html", "View the leaderboard"));
    } else {
      actions.appendChild(makeLink("btn btn-primary", "leaderboard.html", "View the leaderboard"));
    }
    heroBox.appendChild(actions);

    if (ev.season < 2027) {
      heroBox.appendChild(el("p", "rehearsal-note",
        "Rehearsal weekend: this is a real 2026 race used as a dry run for the 2027 game. " +
        "Points count for this test only."));
    }
  }

  function renderSchedule() {
    scheduleBox.textContent = "";
    var timed = timedSessions();
    if (timed.length === 0) {
      scheduleBox.appendChild(el("p", "empty",
        "Session times are not published yet. They are filled in automatically from the official schedule."));
      return;
    }

    var now = Date.now();
    timed.forEach(function (s) {
      var lockMs = lockTimeFor(s);
      var state = "open";
      var note;
      if (lockMs !== null && lockMs <= now) {
        state = "locked";
        note = "Predictions locked";
      } else {
        if (lockMs !== null && lockMs - now < 86400000) { state = "soon"; }
        var locksItself = LOCK_TYPE[s.session_type] === s.session_type;
        note = locksItself
          ? "Predictions lock when this session starts"
          : "Predictions lock when " + TYPE_LABEL[LOCK_TYPE[s.session_type]] + " starts";
      }

      var row = el("div", "session");
      row.setAttribute("data-state", state);
      row.appendChild(el("span", "session-name", TYPE_LABEL[s.session_type] || s.session_type));
      row.appendChild(el("span", "session-time", whenText(s.start_utc)));
      row.appendChild(el("span", "session-note", note));

      var mine = "";
      if (current.signedIn) {
        mine = current.mine[s.id]
          ? "You predicted this"
          : (state === "locked" ? "No prediction made" : "Not predicted yet");
      }
      row.appendChild(el("span", "session-mine", mine));
      scheduleBox.appendChild(row);
    });
  }

  function renderStandings(rows, message) {
    standingsBox.textContent = "";
    if (message) {
      standingsBox.appendChild(el("p", "empty", message));
      return;
    }

    var rank = 0;
    var previous = null;
    rows.forEach(function (row, index) {
      if (row.total_points !== previous) {
        rank = index + 1;
        previous = row.total_points;
      }
      var item = el("div", "tower-row");
      item.appendChild(el("span", "tower-pos", String(rank)));
      var chip = el("span", "tower-chip");
      chip.style.setProperty("--chip", colorFor(row.display_name));
      item.appendChild(chip);
      item.appendChild(el("span", "tower-name", row.display_name));
      item.appendChild(el("span", "tower-points", String(row.total_points)));
      standingsBox.appendChild(item);
    });
    standingsBox.appendChild(makeLink("full-link", "leaderboard.html", "Full leaderboard"));
  }

  function tick() {
    if (!current.ev) { return; }
    var state = computeState(Date.now());
    if (state.signature !== lastSignature) {
      renderHero();
      renderSchedule();
      return;
    }
    if (clockNode) { fillClock(clockNode, state.remaining); }
  }

  function loadAccountData(ev) {
    var ids = current.sessions.map(function (s) { return s.id; });
    return Promise.all([
      client.from("predictions").select("session_id").eq("user_id", current.userId).in("session_id", ids),
      client.from("leaderboard").select("display_name, total_points").eq("season", ev.season)
        .order("total_points", { ascending: false }).order("display_name", { ascending: true }).limit(3)
    ]).then(function (results) {
      var mine = {};
      if (!results[0].error) {
        (results[0].data || []).forEach(function (p) { mine[p.session_id] = true; });
      }
      current.mine = mine;
      renderSchedule();

      if (results[1].error) {
        renderStandings(null, "Standings are not available right now.");
        return;
      }
      var rows = results[1].data || [];
      if (rows.length === 0) {
        renderStandings(null, "No points yet. The first points arrive after qualifying and an admin's approval.");
        return;
      }
      renderStandings(rows, null);
    });
  }

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    current.signedIn = !!session;
    current.userId = session ? session.user.id : null;

    var todayIso = new Date().toISOString().slice(0, 10);
    return client.from("events")
      .select("id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status")
      .lt("season", 9000).neq("status", "cancelled").gte("end_date", todayIso)
      .order("start_date", { ascending: true }).limit(1);
  }).then(function (result) {
    if (result.error) { throw result.error; }
    if (!result.data || result.data.length === 0) {
      showHeroMessage("No upcoming races found.");
      scheduleBox.textContent = "";
      standingsBox.textContent = "";
      return;
    }
    current.ev = result.data[0];
    seasonNote.textContent = current.ev.season + " season" + (current.ev.season < 2027 ? " (rehearsal)" : "");

    return client.from("sessions").select("id, session_type, start_utc").eq("event_id", current.ev.id)
      .then(function (sessions) {
        if (sessions.error) { throw sessions.error; }
        current.sessions = sessions.data || [];
        renderHero();
        renderSchedule();
        setInterval(tick, 30000);

        if (!current.signedIn) {
          renderStandings(null, "Sign in to see the standings.");
          return;
        }
        return loadAccountData(current.ev);
      });
  }).catch(function (err) {
    console.error(err);
    showHeroMessage("Could not load the schedule. Please reload the page.");
  });
})();