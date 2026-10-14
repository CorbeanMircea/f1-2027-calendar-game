(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};

  function byId(id) { return document.getElementById(id); }

  var messageEl = byId("pred-message");
  var gate = byId("gate");
  var gateText = byId("gate-text");
  var panel = byId("predict-panel");
  var emptyText = byId("empty-text");
  var formArea = byId("form-area");
  var sessionSelect = byId("session-select");
  var lockInfo = byId("lock-info");
  var formEl = byId("predict-form");
  var fieldsEl = byId("pick-fields");
  var saveButton = byId("save-button");

  var RACE_SLOTS = [
    ["p1", "P1 (winner)"], ["p2", "P2"], ["p3", "P3"], ["p4", "P4"], ["p5", "P5"],
    ["pole", "Pole position"], ["fastest_lap", "Fastest lap"]
  ];
  var SPRINT_SLOTS = [["p1", "P1 (winner)"], ["p2", "P2"], ["p3", "P3"]];

  var user = null;
  var windowsById = {};
  var eventsById = {};
  var currentSlots = [];
  var currentTarget = "race";
  var loadToken = 0;

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function setShown(el, on) { el.hidden = !on; }

  function showGate(text) {
    gateText.textContent = text;
    setShown(gate, true);
    setShown(panel, false);
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    setMessage("error", "Site configuration is incomplete.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  function makeOption(value, text) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    return opt;
  }

  function buildFields(drivers, existing) {
    fieldsEl.textContent = "";
    var slots = currentTarget === "race" ? RACE_SLOTS : SPRINT_SLOTS;
    currentSlots = slots;

    slots.forEach(function (slot) {
      var wrap = document.createElement("div");
      wrap.className = "field";

      var label = document.createElement("label");
      label.setAttribute("for", "pick-" + slot[0]);
      label.textContent = slot[1];

      var select = document.createElement("select");
      select.id = "pick-" + slot[0];
      select.appendChild(makeOption("", "Choose a driver..."));
      drivers.forEach(function (d) {
        select.appendChild(makeOption(d.id, d.code + " - " + d.full_name + " (" + d.team_name + ")"));
      });
      if (existing && existing[slot[0]]) { select.value = existing[slot[0]]; }

      wrap.appendChild(label);
      wrap.appendChild(select);
      fieldsEl.appendChild(wrap);
    });

    saveButton.disabled = false;
  }

  function loadSession(sessionId) {
    var token = ++loadToken;
    var w = windowsById[sessionId];
    var ev = eventsById[w.event_id];
    currentTarget = w.target_type;

    lockInfo.textContent = "Locks " +
      new Date(w.lock_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) +
      " (your local time). You can change your picks until then.";
    fieldsEl.textContent = "";
    saveButton.disabled = true;

    return Promise.all([
      client.from("drivers").select("id, code, full_name, team_name")
        .eq("season", ev.season).eq("is_active", true).order("code"),
      client.from("predictions").select("p1, p2, p3, p4, p5, pole, fastest_lap")
        .eq("user_id", user.id).eq("session_id", sessionId).limit(1)
    ]).then(function (results) {
      if (token !== loadToken) { return; }
      var driversResult = results[0];
      var existingResult = results[1];
      if (driversResult.error) { throw driversResult.error; }
      if (existingResult.error) { throw existingResult.error; }

      var drivers = driversResult.data || [];
      if (drivers.length === 0) {
        setMessage("error", "The driver list for this season has not been loaded yet.");
        return;
      }
      setMessage("", "");
      buildFields(drivers, existingResult.data && existingResult.data[0]);
    });
  }

  function loadWindows(keepId) {
    return Promise.all([
      client.from("prediction_windows").select("session_id, event_id, target_type, lock_at")
        .eq("is_open", true).order("lock_at", { ascending: true }),
      client.from("events").select("id, season, round, name")
    ]).then(function (results) {
      var windowsResult = results[0];
      var eventsResult = results[1];
      if (windowsResult.error) { throw windowsResult.error; }
      if (eventsResult.error) { throw eventsResult.error; }

      windowsById = {};
      eventsById = {};
      (eventsResult.data || []).forEach(function (e) { eventsById[e.id] = e; });

      var list = (windowsResult.data || []).filter(function (w) { return eventsById[w.event_id]; });

      sessionSelect.textContent = "";
      list.forEach(function (w) {
        windowsById[w.session_id] = w;
        var kind = w.target_type === "race" ? "Race" : "Sprint";
        sessionSelect.appendChild(makeOption(w.session_id, eventsById[w.event_id].name + " - " + kind));
      });

      if (list.length === 0) {
        setShown(emptyText, true);
        setShown(formArea, false);
        return;
      }

      setShown(emptyText, false);
      setShown(formArea, true);
      if (keepId && windowsById[keepId]) { sessionSelect.value = keepId; }
      return loadSession(sessionSelect.value);
    });
  }

  function handleLoadError(err) {
    console.error(err);
    setMessage("error", "Could not load predictions. Please reload the page.");
  }

  sessionSelect.addEventListener("change", function () {
    setMessage("", "");
    loadSession(sessionSelect.value).catch(handleLoadError);
  });

  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var sessionId = sessionSelect.value;
    if (!sessionId || !windowsById[sessionId]) { return; }

    var picks = {};
    for (var i = 0; i < currentSlots.length; i++) {
      var key = currentSlots[i][0];
      var value = byId("pick-" + key).value;
      if (!value) {
        setMessage("error", "Please choose a driver for every position.");
        return;
      }
      picks[key] = value;
    }

    var topKeys = ["p1", "p2", "p3", "p4", "p5"];
    var seen = {};
    for (var j = 0; j < topKeys.length; j++) {
      var k = topKeys[j];
      if (picks[k] === undefined) { continue; }
      if (seen[picks[k]]) {
        setMessage("error", "Each finishing position needs a different driver.");
        return;
      }
      seen[picks[k]] = true;
    }

    var params = {
      p_session_id: sessionId,
      p_p1: picks.p1,
      p_p2: picks.p2,
      p_p3: picks.p3
    };
    if (currentTarget === "race") {
      params.p_p4 = picks.p4;
      params.p_p5 = picks.p5;
      params.p_pole = picks.pole;
      params.p_fastest_lap = picks.fastest_lap;
    }

    saveButton.disabled = true;
    setMessage("", "Saving...");
    client.rpc("submit_prediction", params).then(function (result) {
      saveButton.disabled = false;
      if (result.error) {
        setMessage("error", result.error.message);
        if (result.error.message.indexOf("closed") !== -1) {
          loadWindows(null).catch(handleLoadError);
        }
        return;
      }
      setMessage("ok", "Prediction saved. You can change it until the lock time.");
    }).catch(function (err) {
      saveButton.disabled = false;
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
    });
  });

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) {
      showGate("Please sign in on the Account page to make predictions.");
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
        setShown(panel, true);
        return loadWindows(null);
      });
  }).catch(handleLoadError);
})();