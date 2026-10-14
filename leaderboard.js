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
  var tableWrap = byId("table-wrap");
  var tbody = byId("board-body");

  var user = null;
  var currentSeason = null;
  var refreshTimer = null;
  var channel = null;

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function setShown(el, on) { el.hidden = !on; }

  function showGate(text) {
    gateText.textContent = text;
    setShown(gate, true);
    setShown(boardPanel, false);
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    setMessage("error", "Site configuration is incomplete.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  function seasonLabel(season) {
    return season === 9999 ? "Practice (test)" : season + " season";
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

  function makeCell(tag, className, text) {
    var cell = document.createElement(tag);
    if (className) { cell.className = className; }
    cell.textContent = text;
    return cell;
  }

  function renderRows(rows) {
    tbody.textContent = "";
    var rank = 0;
    var previous = null;

    rows.forEach(function (row, index) {
      if (row.total_points !== previous) {
        rank = index + 1;
        previous = row.total_points;
      }
      var tr = document.createElement("tr");
      if (user && row.user_id === user.id) { tr.className = "me"; }
      tr.appendChild(makeCell("td", "rank", String(rank)));
      tr.appendChild(makeCell("td", "", row.display_name));
      tr.appendChild(makeCell("td", "num", String(row.total_points)));
      tr.appendChild(makeCell("td", "num", String(row.sessions_scored)));
      tbody.appendChild(tr);
    });
  }

  function loadRows() {
    return client.from("leaderboard")
      .select("user_id, display_name, total_points, sessions_scored")
      .eq("season", currentSeason)
      .order("total_points", { ascending: false })
      .order("display_name", { ascending: true })
      .then(function (result) {
        if (result.error) { throw result.error; }
        renderRows(result.data || []);
        updatedEl.textContent = "Updated " +
          new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      });
  }

  // Load which seasons have scores, then the rows for the selected season.
  function loadAll() {
    return client.from("leaderboard").select("season").then(function (result) {
      if (result.error) { throw result.error; }

      var seen = {};
      var seasons = [];
      (result.data || []).forEach(function (row) {
        if (!seen[row.season]) { seen[row.season] = true; seasons.push(row.season); }
      });

      if (seasons.length === 0) {
        setShown(seasonField, false);
        setShown(tableWrap, false);
        setShown(emptyText, true);
        updatedEl.textContent = "";
        return;
      }

      // Real seasons first (newest first), the practice season last.
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
      setShown(emptyText, false);
      setShown(tableWrap, true);
      return loadRows();
    });
  }

  function handleError(err) {
    console.error(err);
    setMessage("error", "Could not load the leaderboard. Please reload the page.");
  }

  function scheduleRefresh() {
    if (refreshTimer) { clearTimeout(refreshTimer); }
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      loadAll().then(function () { setMessage("", ""); }).catch(handleError);
    }, 600);
  }

  seasonSelect.addEventListener("change", function () {
    currentSeason = Number(seasonSelect.value);
    loadRows().catch(handleError);
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
        return loadAll();
      });
  }).catch(handleError);
})();