(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var hero = document.getElementById("hero");
  var textBox = document.getElementById("hero-content");
  var panelBox = document.getElementById("status-panel");
  var scheduleBox = document.getElementById("schedule-rows");
  var standingsBox = document.getElementById("standings-rows");
  var seasonNote = document.getElementById("standings-season");
  var lightEls = document.querySelectorAll(".gantry .light");
  var lightsCount = document.getElementById("lights-count");
  var photoEl = document.getElementById("hero-photo");
  var motifEl = document.getElementById("hero-motif");
  var circuitSvg = document.getElementById("hero-circuit");
  var cUnder = document.getElementById("c-under");
  var cLine = document.getElementById("c-line");
  var cStart = document.getElementById("c-start");
  if (!hero || !textBox || !panelBox || !scheduleBox || !standingsBox) { return; }

  var TYPE_LABEL = {
    sprint_qualifying: "Sprint Qualifying",
    sprint: "Sprint",
    qualifying: "Qualifying",
    race: "Race"
  };
  // Which qualifying session locks the predictions for each session type (unchanged rule).
  var LOCK_TYPE = {
    qualifying: "qualifying",
    race: "qualifying",
    sprint_qualifying: "sprint_qualifying",
    sprint: "sprint_qualifying"
  };
  var FLAG_TEXT = {
    tbc: "Times to be confirmed",
    open: "Predictions open",
    soon: "Locks soon",
    locked: "Predictions locked",
    done: "Results published"
  };

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

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function showHeroMessage(text) {
    textBox.textContent = "";
    panelBox.textContent = "";
    textBox.appendChild(el("p", "placeholder", text));
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    showHeroMessage("Site configuration is incomplete.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  // ---------- Reveal on scroll ----------

  var observer = null;

  function getObserver() {
    if (observer) { return observer; }
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -4% 0px" });
    return observer;
  }

  function reveal(node, index, animate) {
    node.setAttribute("data-reveal", "");
    node.style.setProperty("--i", String(index || 0));
    if (!animate || reducedMotion() || !("IntersectionObserver" in window)) {
      node.classList.add("in");
    } else {
      getObserver().observe(node);
    }
    return node;
  }

  function initStaticReveal() {
    var nodes = document.querySelectorAll("[data-reveal]");
    for (var i = 0; i < nodes.length; i++) {
      if (reducedMotion() || !("IntersectionObserver" in window)) {
        nodes[i].classList.add("in");
      } else {
        getObserver().observe(nodes[i]);
      }
    }
    // Safety net: never leave content hidden.
    window.setTimeout(function () {
      var all = document.querySelectorAll("[data-reveal]:not(.in)");
      for (var j = 0; j < all.length; j++) { all[j].classList.add("in"); }
    }, 4000);
  }

  // ---------- Dates ----------

  var monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });
  var dayFormat = new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", month: "short" });
  var timeFormat = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

  function parseDay(isoDate) { return new Date(isoDate + "T00:00:00Z"); }

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

  // ---------- State ----------

  var current = { ev: null, sessions: [], mine: {}, results: {}, signedIn: false, userId: null };
  var clockCells = [];
  var captionNode = null;
  var lastSignature = "";
  var lastLit = -1;
  var firstLightsDone = false;
  var entering = false;
  var reloading = false;
  var timerStarted = false;
  var channel = null;

  function msOf(session) { return Date.parse(session.start_utc); }

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

  // The race result being approved means the weekend is complete.
  function resultsPublished() {
    for (var i = 0; i < current.sessions.length; i++) {
      var s = current.sessions[i];
      if (s.session_type === "race" && current.results[s.id]) { return true; }
    }
    return false;
  }

  // done: race result approved. tbc: no times. open / soon: before the next lock. locked: all locks passed.
  function computeState(now) {
    var timed = timedSessions();
    if (timed.length === 0) { return { kind: "tbc", signature: "tbc" }; }
    if (resultsPublished()) { return { kind: "done", signature: "done" }; }

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
        return { kind: "locked", session: timed[j], remaining: msOf(timed[j]) - now, signature: "locked" + timed[j].id };
      }
    }
    return { kind: "locked", session: null, remaining: 0, signature: "finished" };
  }

  // ---------- Start lights ----------
  // Upcoming (times unknown): off. Open: 1 to 4 lit, more as the deadline nears.
  // Locked: all five. Results published: off.

  function litCount(state) {
    if (state.kind === "locked") { return 5; }
    if (state.kind !== "open" && state.kind !== "soon") { return 0; }
    var hours = state.remaining / 3600000;
    if (hours <= 6) { return 4; }
    if (hours <= 24) { return 3; }
    if (hours <= 72) { return 2; }
    return 1;
  }

  function lightsCaption(state, target) {
    if (state.kind === "open" || state.kind === "soon") {
      return target + " of 5 lights on. More come on as the deadline nears, and all five show when predictions lock.";
    }
    if (state.kind === "locked") { return "All five lights on: predictions are locked."; }
    if (state.kind === "done") { return "Results are published. Lights out."; }
    return "Lights out until the session times are confirmed.";
  }

  function setLights(count, sequence) {
    for (var i = 0; i < lightEls.length; i++) {
      lightEls[i].style.setProperty("--d", (sequence ? i * 130 : 0) + "ms");
      if (i < count) { lightEls[i].classList.add("is-lit"); } else { lightEls[i].classList.remove("is-lit"); }
    }
    lastLit = count;
    if (lightsCount) { lightsCount.textContent = count + " / 5"; }
  }

  function playedBefore() {
    try { return window.sessionStorage.getItem("lo-lights") === "1"; } catch (e) { return false; }
  }

  function markPlayed() {
    try { window.sessionStorage.setItem("lo-lights", "1"); } catch (e) { /* ignore */ }
  }

  function applyLights(target) {
    if (!firstLightsDone) {
      firstLightsDone = true;
      if (target > 0 && !reducedMotion() && !playedBefore()) {
        setLights(0, false);
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(function () {
            setLights(target, true);
            markPlayed();
          });
        });
        return;
      }
    }
    setLights(target, false);
  }

  // Pressing the main button: lights come on one by one, go out, then the page opens.
  function enterRace(href) {
    if (entering || reducedMotion() || lightEls.length === 0) {
      window.location.href = href;
      return;
    }
    entering = true;
    var step = 70;
    var i;
    for (i = 0; i < lightEls.length; i++) {
      lightEls[i].style.setProperty("--d", "0ms");
      lightEls[i].classList.remove("is-lit");
    }
    for (i = 0; i < lightEls.length; i++) {
      (function (index) {
        window.setTimeout(function () { lightEls[index].classList.add("is-lit"); }, 50 + index * step);
      })(i);
    }
    var outAt = 50 + lightEls.length * step + 100;
    window.setTimeout(function () {
      for (var j = 0; j < lightEls.length; j++) { lightEls[j].classList.remove("is-lit"); }
    }, outAt);
    window.setTimeout(function () { window.location.href = href; }, outAt + 110);
  }

  hero.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("a[data-enter]") : null;
    if (!link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    enterRace(link.href);
  });

  // ---------- Grand Prix theme ----------

  function setCircuit(line) {
    circuitSvg.setAttribute("viewBox", line.viewBox);
    cUnder.setAttribute("d", line.d);
    cLine.setAttribute("d", line.d);
    if (line.start) {
      cStart.setAttribute("x1", line.start.x1);
      cStart.setAttribute("y1", line.start.y1);
      cStart.setAttribute("x2", line.start.x2);
      cStart.setAttribute("y2", line.start.y2);
      cStart.style.display = "";
    } else {
      cStart.style.display = "none";
    }
  }

  function applyTheme(ev) {
    var T = window.LO_THEME;
    if (!T) { return; }
    var theme = T.forEvent(ev);
    var token = ev.id;

    hero.classList.remove("is-themed");
    photoEl.classList.remove("on");
    hero.setAttribute("data-race", theme.stem);
    hero.style.setProperty("--atmos", theme.atmos);
    motifEl.innerHTML = theme.motif;
    setCircuit(theme.line);

    // Let the browser paint the neutral state first so the theme fades in.
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { hero.classList.add("is-themed"); });
    });

    // Optional local artwork replaces the generated pieces when the files exist.
    T.loadCircuit(theme.stem).then(function (real) {
      if (real && current.ev && current.ev.id === token) { setCircuit(real); }
    });
    T.loadPhoto(theme.stem).then(function (url) {
      if (url && current.ev && current.ev.id === token) {
        photoEl.style.backgroundImage = "url(\"" + url + "\")";
        photoEl.classList.add("on");
      }
    });
  }

  // ---------- Hero text ----------

  function renderHeroText(animate) {
    var ev = current.ev;
    var state = computeState(Date.now());
    var i = 0;
    textBox.textContent = "";

    var kicker = el("div", "kicker");
    kicker.appendChild(el("span", "kicker-num", pad2(ev.round)));
    var kt = el("p", "kicker-text");
    kt.appendChild(el("span", "k1", "Round " + ev.round + " \u00b7 " + ev.season + " season"));
    kt.appendChild(el("span", "k2", ev.locality + ", " + ev.country));
    kicker.appendChild(kt);
    textBox.appendChild(reveal(kicker, i++, animate));

    var title = el("h1", "hero-title");
    var suffix = " Grand Prix";
    var hasSuffix = ev.name.length > suffix.length && ev.name.slice(-suffix.length) === suffix;
    title.appendChild(el("span", "t-main", hasSuffix ? ev.name.slice(0, -suffix.length) : ev.name));
    if (hasSuffix) { title.appendChild(el("span", "t-sub", "Grand Prix")); }
    textBox.appendChild(reveal(title, i++, animate));

    var facts = el("dl", "hero-facts");
    [["Circuit", ev.circuit], ["Dates", formatRange(ev.start_date, ev.end_date)],
     ["Format", ev.has_sprint ? "Sprint weekend" : "Standard weekend"]].forEach(function (pair) {
      var row = el("div");
      row.appendChild(el("dt", "", pair[0]));
      row.appendChild(el("dd", "", pair[1]));
      facts.appendChild(row);
    });
    textBox.appendChild(reveal(facts, i++, animate));

    if (current.signedIn) {
      var actions = el("div", "hero-actions");
      actions.appendChild(makeLink("btn", "leaderboard.html", "Leaderboard"));
      textBox.appendChild(reveal(actions, i++, animate));
    }

    if (ev.season < 2027) {
      textBox.appendChild(reveal(el("p", "rehearsal-note",
        "Rehearsal weekend: this is a real 2026 race used as a dry run for the 2027 game. " +
        "Points count for this test only."), i++, animate));
    }
    return state;
  }

  // ---------- Race control panel ----------

  function buildClock() {
    var wrap = el("div", "cd");
    wrap.setAttribute("role", "timer");
    clockCells = [];
    ["Days", "Hours", "Min", "Sec"].forEach(function (label) {
      var cell = el("div", "cd-cell");
      var num = el("span", "cd-num", "00");
      cell.appendChild(num);
      cell.appendChild(el("span", "cd-lab", label));
      wrap.appendChild(cell);
      clockCells.push(num);
    });
    return wrap;
  }

  function updateClock(ms) {
    if (clockCells.length === 0) { return; }
    var total = Math.max(0, Math.floor(ms / 1000));
    var values = [
      Math.floor(total / 86400), Math.floor((total % 86400) / 3600),
      Math.floor((total % 3600) / 60), total % 60
    ].map(pad2);
    for (var i = 0; i < values.length; i++) {
      var node = clockCells[i];
      if (node.textContent !== values[i]) {
        node.textContent = values[i];
        if (!reducedMotion()) {
          node.classList.remove("tick");
          void node.offsetWidth;
          node.classList.add("tick");
        }
      }
    }
  }

  function addRow(list, label, valueNode) {
    var row = el("div");
    row.appendChild(el("dt", "", label));
    var dd = el("dd");
    dd.appendChild(valueNode);
    row.appendChild(dd);
    list.appendChild(row);
  }

  function renderPanel(animate) {
    var state = computeState(Date.now());
    lastSignature = state.signature;
    clockCells = [];
    panelBox.textContent = "";
    panelBox.setAttribute("data-state", state.kind);

    var head = el("div", "rc-head");
    head.appendChild(el("span", "rc-title", "Race control"));
    head.appendChild(el("span", "rc-flag", FLAG_TEXT[state.kind]));
    panelBox.appendChild(head);

    var body = el("div", "rc-body");
    var rows = el("dl", "rc-rows");

    if (state.kind === "tbc") {
      body.appendChild(el("p", "rc-label", "Session times"));
      body.appendChild(el("p", "rc-word", "To be confirmed"));
      body.appendChild(el("p", "rc-detail", "Predictions open once the official schedule is published."));
    } else if (state.kind === "done" || !state.session) {
      body.appendChild(el("p", "rc-label", "This weekend"));
      body.appendChild(el("p", "rc-word", state.kind === "done" ? "Complete" : "Finished"));
      body.appendChild(el("p", "rc-detail", "Points appear on the leaderboard after an admin approves each result."));
    } else {
      body.appendChild(el("p", "rc-label",
        state.kind === "locked" ? TYPE_LABEL[state.session.session_type] + " starts in" : "Predictions lock in"));
      body.appendChild(buildClock());
      updateClock(state.remaining);
      addRow(rows, state.kind === "locked" ? "Next session" : "Deadline",
        document.createTextNode(TYPE_LABEL[state.session.session_type] + " \u00b7 " + whenText(state.session.start_utc)));
    }

    var timed = timedSessions();
    if (current.signedIn && timed.length > 0) {
      var made = 0;
      var pips = el("span", "pips");
      timed.forEach(function (s) {
        var pip = el("i");
        if (current.mine[s.id]) { pip.className = "on"; made++; }
        pips.appendChild(pip);
      });
      var mine = el("span");
      mine.appendChild(pips);
      mine.appendChild(document.createTextNode(made + " of " + timed.length + " sessions"));
      addRow(rows, "Your picks", mine);
    }
    if (rows.childNodes.length > 0) { body.appendChild(rows); }

    // Primary action
    var cta;
    if (!current.signedIn) {
      cta = makeLink("btn btn-primary btn-block btn-arrow rc-cta", "account.html", "Sign in or create an account");
    } else if (state.kind === "open" || state.kind === "soon") {
      cta = makeLink("btn btn-primary btn-block btn-arrow rc-cta", "predict.html", "Make your predictions");
      cta.setAttribute("data-enter", "1");
    } else {
      cta = makeLink("btn btn-primary btn-block btn-arrow rc-cta", "leaderboard.html", "View the leaderboard");
    }
    body.appendChild(cta);

    var target = litCount(state);
    captionNode = el("p", "rc-lights", lightsCaption(state, target));
    body.appendChild(captionNode);

    panelBox.appendChild(body);
    reveal(panelBox, 2, animate);
    applyLights(target);
  }

  // ---------- Schedule ----------

  function renderSchedule(animate) {
    scheduleBox.textContent = "";
    var timed = timedSessions();
    if (timed.length === 0) {
      scheduleBox.appendChild(el("p", "empty",
        "Session times are not published yet. They are filled in automatically from the official schedule."));
      return;
    }

    var now = Date.now();
    var list = el("ol", "tl");
    var lastDay = "";
    var nextFound = false;

    timed.forEach(function (s, index) {
      var lockMs = lockTimeFor(s);
      var start = msOf(s);
      var state;
      var tag;
      var note;

      if (current.results[s.id]) {
        state = "done"; tag = "Results in"; note = "Result approved";
      } else if (start <= now) {
        state = "past"; tag = "Awaiting result"; note = "Session has started";
      } else if (lockMs !== null && lockMs <= now) {
        state = "locked"; tag = "Locked"; note = "Predictions locked";
      } else {
        state = lockMs !== null && lockMs - now < 86400000 ? "soon" : "open";
        tag = state === "soon" ? "Closes soon" : "Open";
        note = LOCK_TYPE[s.session_type] === s.session_type
          ? "Predictions lock when this session starts"
          : "Predictions lock when " + TYPE_LABEL[LOCK_TYPE[s.session_type]] + " starts";
      }

      var item = el("li", "tl-item");
      item.setAttribute("data-state", state);
      if (!nextFound && start > now) { item.className += " is-next"; nextFound = true; }

      var dayKey = dayFormat.format(new Date(start));
      if (dayKey !== lastDay) {
        item.appendChild(el("span", "tl-day", dayKey));
        lastDay = dayKey;
      }
      item.appendChild(el("span", "tl-node"));

      var card = el("div", "tl-card");
      var top = el("div", "tl-top");
      top.appendChild(el("span", "tl-name", TYPE_LABEL[s.session_type] || s.session_type));
      top.appendChild(el("span", "tl-tag", item.className.indexOf("is-next") >= 0 && state !== "locked" ? "Next \u00b7 " + tag : tag));
      card.appendChild(top);
      card.appendChild(el("p", "tl-time", timeFormat.format(new Date(start))));
      card.appendChild(el("p", "tl-note", note));
      if (current.signedIn) {
        card.appendChild(el("p", "tl-mine", current.mine[s.id]
          ? "You predicted this"
          : (state === "open" || state === "soon" ? "Not predicted yet" : "No prediction made")));
      }
      item.appendChild(card);
      reveal(item, index, animate);
      list.appendChild(item);
    });
    scheduleBox.appendChild(list);
  }

  // ---------- Standings ----------

  function initials(name) {
    var parts = String(name).trim().split(/\s+/);
    if (parts.length > 1) { return (parts[0].charAt(0) + parts[1].charAt(0)); }
    return String(name).trim().slice(0, 2);
  }

  function countUp(node, to, animate) {
    var from = parseInt(node.getAttribute("data-value") || "0", 10);
    node.setAttribute("data-value", String(to));
    if (!animate || reducedMotion() || from === to) {
      node.textContent = String(to);
      return;
    }
    var startTime = null;
    var duration = 800;
    function frame(t) {
      if (startTime === null) { startTime = t; }
      var p = Math.min(1, (t - startTime) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(from + (to - from) * eased));
      if (p < 1) { window.requestAnimationFrame(frame); }
    }
    window.requestAnimationFrame(frame);
  }

  function renderStandings(rows, message, animate) {
    if (message) {
      standingsBox.textContent = "";
      standingsBox.appendChild(el("p", "empty", message));
      return;
    }

    var list = standingsBox.querySelector(".st-list");
    var firstRender = !list;
    if (firstRender) {
      standingsBox.textContent = "";
      list = el("ol", "st-list");
      standingsBox.appendChild(list);
      standingsBox.appendChild(makeLink("full-link", "leaderboard.html", "Full leaderboard \u2192"));
    }

    // FLIP: remember where each row is, reorder, then animate from the old position.
    var before = {};
    var existing = {};
    var items = list.children;
    for (var i = 0; i < items.length; i++) {
      var key = items[i].getAttribute("data-id");
      existing[key] = items[i];
      before[key] = items[i].getBoundingClientRect().top;
    }

    var keep = {};
    var rank = 0;
    var previous = null;
    var leaderPoints = rows.length ? rows[0].total_points : 0;

    rows.forEach(function (row, index) {
      if (row.total_points !== previous) { rank = index + 1; previous = row.total_points; }
      keep[row.user_id] = true;

      var li = existing[row.user_id];
      if (!li) {
        li = el("li", "st-row");
        li.setAttribute("data-id", row.user_id);
        li.appendChild(el("span", "st-pos"));
        li.appendChild(el("span", "st-av"));
        var name = el("span", "st-name");
        name.appendChild(el("span", "st-n"));
        name.appendChild(el("span", "st-sub"));
        li.appendChild(name);
        li.appendChild(el("span", "st-pts"));
      }
      li.querySelector(".st-pos").textContent = String(rank);
      li.querySelector(".st-av").textContent = initials(row.display_name);
      li.querySelector(".st-n").textContent = row.display_name;

      var scored = row.sessions_scored + (row.sessions_scored === 1 ? " session" : " sessions");
      var gap = leaderPoints - row.total_points;
      li.querySelector(".st-sub").textContent = rank === 1
        ? "Leader \u00b7 " + scored
        : (gap === 0 ? "Level on points" : gap + " behind \u00b7 " + scored);
      li.className = "st-row" + (rank === 1 ? " is-leader" : "");
      countUp(li.querySelector(".st-pts"), row.total_points, animate);
      list.appendChild(li); // appending an existing node moves it into the new order
    });

    Object.keys(existing).forEach(function (key) {
      if (!keep[key]) { list.removeChild(existing[key]); }
    });

    if (!firstRender && animate && !reducedMotion()) {
      var rowsNow = list.children;
      for (var j = 0; j < rowsNow.length; j++) {
        (function (node) {
          var id = node.getAttribute("data-id");
          if (before[id] === undefined) { return; }
          var dy = before[id] - node.getBoundingClientRect().top;
          if (!dy) { return; }
          node.style.transition = "none";
          node.style.transform = "translateY(" + dy + "px)";
          window.requestAnimationFrame(function () {
            node.style.transition = "transform 0.55s cubic-bezier(0.2, 0.7, 0.2, 1)";
            node.style.transform = "";
          });
        })(rowsNow[j]);
      }
    }
  }

  // ---------- Data ----------

  function fetchStandings() {
    return client.from("leaderboard").select("user_id, display_name, total_points, sessions_scored")
      .eq("season", current.ev.season)
      .order("total_points", { ascending: false }).order("display_name", { ascending: true }).limit(5);
  }

  function showStandings(result, animate) {
    if (result.error) {
      renderStandings(null, "Standings are not available right now.", false);
      return;
    }
    var rows = result.data || [];
    if (rows.length === 0) {
      renderStandings(null, "No points yet. The first points arrive after qualifying and an admin's approval.", false);
      return;
    }
    renderStandings(rows, null, animate);
  }

  function loadAccountData() {
    var ids = current.sessions.map(function (s) { return s.id; });
    return Promise.all([
      client.from("predictions").select("session_id").eq("user_id", current.userId).in("session_id", ids),
      client.from("results").select("session_id").eq("status", "approved").in("session_id", ids),
      fetchStandings()
    ]).then(function (results) {
      var mine = {};
      var done = {};
      if (!results[0].error) { (results[0].data || []).forEach(function (p) { mine[p.session_id] = true; }); }
      if (!results[1].error) { (results[1].data || []).forEach(function (r) { done[r.session_id] = true; }); }
      current.mine = mine;
      current.results = done;
      return results[2];
    });
  }

  // Live updates: when a score or result changes, refresh the standings and the weekend state.
  function startRealtime() {
    if (channel || !current.signedIn || !client.channel) { return; }
    var timer = null;
    function refresh() {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        if (!current.ev) { return; }
        loadAccountData().then(function (standings) {
          if (computeState(Date.now()).signature !== lastSignature) {
            renderHeroText(false);
            renderPanel(false);
          }
          renderSchedule(false);
          showStandings(standings, true);
        }).catch(function (err) { console.error(err); });
      }, 600);
    }
    try {
      channel = client.channel("lo-home")
        .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, refresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "results" }, refresh)
        .subscribe();
    } catch (e) { console.error(e); }
  }

  function tick() {
    if (!current.ev) { return; }
    var todayIso = new Date().toISOString().slice(0, 10);
    if (todayIso > current.ev.end_date && !reloading) {
      reloading = true;
      loadEvent(true).then(function () { reloading = false; }, function () { reloading = false; });
      return;
    }
    var state = computeState(Date.now());
    if (state.signature !== lastSignature) {
      renderHeroText(false);
      renderPanel(false);
      renderSchedule(false);
      return;
    }
    updateClock(state.remaining || 0);
    var target = litCount(state);
    if (target !== lastLit && !entering) {
      setLights(target, false);
      if (captionNode) { captionNode.textContent = lightsCaption(state, target); }
    }
  }

  function loadEvent(isReload) {
    var todayIso = new Date().toISOString().slice(0, 10);
    return client.from("events")
      .select("id, season, round, name, circuit, locality, country, start_date, end_date, has_sprint, status")
      .lt("season", 9000).neq("status", "cancelled").gte("end_date", todayIso)
      .order("start_date", { ascending: true }).limit(1)
      .then(function (result) {
        if (result.error) { throw result.error; }
        if (!result.data || result.data.length === 0) {
          showHeroMessage("No upcoming races found.");
          scheduleBox.textContent = "";
          standingsBox.textContent = "";
          return null;
        }
        var ev = result.data[0];
        if (isReload && current.ev && current.ev.id === ev.id) { return null; }

        current.ev = ev;
        current.sessions = [];
        current.mine = {};
        current.results = {};
        firstLightsDone = isReload ? true : false;
        seasonNote.textContent = ev.season + " season" + (ev.season < 2027 ? " (rehearsal)" : "");
        applyTheme(ev);

        return client.from("sessions").select("id, session_type, start_utc").eq("event_id", ev.id)
          .then(function (sessions) {
            if (sessions.error) { throw sessions.error; }
            current.sessions = sessions.data || [];
            return current.signedIn ? loadAccountData() : null;
          })
          .then(function (standings) {
            var animate = !isReload;
            renderHeroText(animate);
            renderPanel(animate);
            renderSchedule(animate);
            standingsBox.textContent = "";
            if (!current.signedIn) {
              renderStandings(null, "Sign in to see the standings.", false);
              return;
            }
            showStandings(standings, false);
            startRealtime();
          });
      });
  }

  initStaticReveal();

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    current.signedIn = !!session;
    current.userId = session ? session.user.id : null;
    return loadEvent(false);
  }).then(function () {
    if (!timerStarted) {
      timerStarted = true;
      window.setInterval(tick, 1000);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) { tick(); } });
    }
  }).catch(function (err) {
    console.error(err);
    showHeroMessage("Could not load the schedule. Please reload the page.");
  });
})();