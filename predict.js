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

  var TYPE_LABEL = {
    qualifying: "Qualifying",
    sprint_qualifying: "Sprint Qualifying",
    race: "Race",
    sprint: "Sprint"
  };
  var TYPE_ORDER = { sprint_qualifying: 1, sprint: 2, qualifying: 3, race: 4 };

  var NOTES = {
    qualifying: "Pick who is knocked out in Q1 and Q2, then rank the 10 drivers who reach Q3. " +
      "Points: 1 per driver in the right group, +3 per exact Q3 position, +10 for a perfect top 10 (max 62).",
    sprint_qualifying: "Pick who is knocked out in SQ1 and SQ2, then rank the 10 drivers who reach SQ3. " +
      "Points: 1 per driver in the right group, +3 per exact SQ3 position, +10 for a perfect top 10 (max 62).",
    race: "Predict the top 8, the fastest lap and the DNFs. Points: 5 per exact position, 2 per driver " +
      "in the top 8 but in the wrong place, +15 for a perfect top 8. Fastest lap 3. DNF questions: any DNF 2, " +
      "exact count 5 (off by one 2), DNF driver 4 (8 if that driver started in the real top 8). Max 73. " +
      "A driver cannot be both in your top 8 and your DNF pick.",
    sprint: "Predict the top 8. Points: 3 per exact position, 1 per driver in the top 8 but in the wrong place, " +
      "+8 for a perfect top 8 (max 32)."
  };

  var user = null;
  var windowsById = {};
  var eventsById = {};
  var drivers = [];
  var controller = null;
  var loadToken = 0;

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function setShown(node, on) { node.hidden = !on; }

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

  // ---------- small DOM helpers ----------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function makeOption(value, text) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    return opt;
  }

  function driverById(id) {
    for (var i = 0; i < drivers.length; i++) {
      if (drivers[i].id === id) { return drivers[i]; }
    }
    return null;
  }

  function driverLabel(d) {
    return d.code + " - " + d.full_name + " (" + d.team_name + ")";
  }

  function filterKnown(list) {
    var out = [];
    if (Array.isArray(list)) {
      list.forEach(function (id) {
        if (driverById(id) && out.indexOf(id) === -1) { out.push(id); }
      });
    }
    return out;
  }

  function makeField(labelText, control) {
    var wrap = el("div", "field");
    var label = el("label", "", labelText);
    label.setAttribute("for", control.id);
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  function makeDriverSelect(id, value, blankText) {
    var select = document.createElement("select");
    select.id = id;
    select.appendChild(makeOption("", blankText));
    drivers.forEach(function (d) { select.appendChild(makeOption(d.id, driverLabel(d))); });
    if (value && driverById(value)) { select.value = value; }
    return select;
  }

  function makeStep(title, hint) {
    var step = el("div", "form-step");
    step.appendChild(el("h3", "", title));
    if (hint) { step.appendChild(el("p", "step-hint", hint)); }
    return step;
  }

  // A group of selects for "P1..Pn" where one driver cannot be chosen twice.
  // getBlocked() may return extra driver ids that must not be offered.
  function makeRankSelects(container, count, existing, prefix, getBlocked) {
    var selects = [];

    function sync() {
      var used = {};
      selects.forEach(function (s) { if (s.value) { used[s.value] = true; } });
      var blocked = getBlocked ? getBlocked() : [];
      selects.forEach(function (s) {
        Array.prototype.forEach.call(s.options, function (opt) {
          if (opt.value === "") { opt.disabled = false; return; }
          var takenElsewhere = used[opt.value] === true && opt.value !== s.value;
          opt.disabled = takenElsewhere || blocked.indexOf(opt.value) !== -1;
        });
      });
    }

    for (var i = 0; i < count; i++) {
      var select = makeDriverSelect(prefix + (i + 1), existing && existing[i], "Choose a driver...");
      select.addEventListener("change", sync);
      selects.push(select);
      container.appendChild(makeField("P" + (i + 1), select));
    }
    sync();

    return {
      values: function () { return selects.map(function (s) { return s.value; }); },
      sync: sync
    };
  }

  // ---------- Qualifying and Sprint Qualifying ----------

  function buildQualifying(container, existing, part) {
    var n = drivers.length;
    var q1Size = n - 16;
    if (q1Size < 1) {
      throw new Error("The driver list for this season is not complete yet.");
    }

    var q1 = filterKnown(existing && existing.q1_out);
    var q2 = filterKnown(existing && existing.q2_out);
    var order = filterKnown(existing && existing.q3_order);

    var step1 = el("div", "form-step");
    var step2 = el("div", "form-step");
    var step3 = el("div", "form-step");
    container.appendChild(step1);
    container.appendChild(step2);
    container.appendChild(step3);

    function counter(count, size) {
      return el("span", "counter" + (count === size ? " done" : ""), count + " / " + size);
    }

    function toggle(list, id, on) {
      var index = list.indexOf(id);
      if (on && index === -1) { list.push(id); }
      if (!on && index !== -1) { list.splice(index, 1); }
    }

    function checkList(list, selected, size, onChange) {
      var ul = el("ul", "driver-list");
      list.forEach(function (d) {
        var li = document.createElement("li");
        var label = document.createElement("label");
        var box = document.createElement("input");
        box.type = "checkbox";
        var isChecked = selected.indexOf(d.id) !== -1;
        box.checked = isChecked;
        if (isChecked) {
          label.className = "checked";
        } else if (selected.length >= size) {
          box.disabled = true;
          label.className = "disabled";
        }
        box.addEventListener("change", function () { onChange(d.id, box.checked); });
        label.appendChild(box);
        label.appendChild(document.createTextNode(driverLabel(d)));
        li.appendChild(label);
        ul.appendChild(li);
      });
      return ul;
    }

    function move(from, to) {
      var tmp = order[from];
      order[from] = order[to];
      order[to] = tmp;
      render();
    }

    function render() {
      q2 = q2.filter(function (id) { return q1.indexOf(id) === -1; });

      var step1Done = q1.length === q1Size;
      var afterQ1 = drivers.filter(function (d) { return q1.indexOf(d.id) === -1; });
      var step2Done = step1Done && q2.length === 6;

      var q3ids = step2Done
        ? afterQ1.filter(function (d) { return q2.indexOf(d.id) === -1; }).map(function (d) { return d.id; })
        : [];
      order = order.filter(function (id) { return q3ids.indexOf(id) !== -1; });
      q3ids.forEach(function (id) { if (order.indexOf(id) === -1) { order.push(id); } });

      // Step 1
      step1.textContent = "";
      var h1 = el("h3", "", "Step 1: knocked out in " + part + "1");
      h1.appendChild(counter(q1.length, q1Size));
      step1.appendChild(h1);
      step1.appendChild(el("p", "step-hint",
        "Choose the " + q1Size + " drivers you think will be eliminated in " + part + "1."));
      step1.appendChild(checkList(drivers, q1, q1Size, function (id, on) {
        toggle(q1, id, on);
        render();
      }));

      // Step 2
      step2.textContent = "";
      var h2 = el("h3", "", "Step 2: knocked out in " + part + "2");
      if (step1Done) { h2.appendChild(counter(q2.length, 6)); }
      step2.appendChild(h2);
      if (!step1Done) {
        step2.appendChild(el("p", "step-hint", "Complete step 1 first."));
      } else {
        step2.appendChild(el("p", "step-hint",
          "From the remaining " + afterQ1.length + " drivers, choose the 6 eliminated in " + part + "2."));
        step2.appendChild(checkList(afterQ1, q2, 6, function (id, on) {
          toggle(q2, id, on);
          render();
        }));
      }

      // Step 3
      step3.textContent = "";
      step3.appendChild(el("h3", "", "Step 3: " + part + "3 order (P1 to P10)"));
      if (!step2Done) {
        step3.appendChild(el("p", "step-hint", "Complete step 2 first."));
      } else {
        step3.appendChild(el("p", "step-hint",
          "These 10 drivers reach " + part + "3. Use the arrows to put them in your predicted order."));
        var ol = el("ol", "order-list");
        order.forEach(function (id, index) {
          var li = document.createElement("li");
          li.appendChild(el("span", "pos", "P" + (index + 1)));
          li.appendChild(el("span", "name", driverLabel(driverById(id))));

          var up = el("button", "", "\u2191");
          up.type = "button";
          up.setAttribute("aria-label", "Move up");
          up.disabled = index === 0;
          up.addEventListener("click", function () { move(index, index - 1); });

          var down = el("button", "", "\u2193");
          down.type = "button";
          down.setAttribute("aria-label", "Move down");
          down.disabled = index === order.length - 1;
          down.addEventListener("click", function () { move(index, index + 1); });

          li.appendChild(up);
          li.appendChild(down);
          ol.appendChild(li);
        });
        step3.appendChild(ol);
      }
    }

    render();

    return {
      getPicks: function () {
        if (q1.length !== q1Size || q2.length !== 6 || order.length !== 10) {
          throw new Error("Please complete all three steps.");
        }
        return { q1_out: q1.slice(), q2_out: q2.slice(), q3_order: order.slice() };
      }
    };
  }

  // ---------- Grand Prix ----------

  function buildRace(container, existing) {
    var dnfSelect = null;

    var topStep = makeStep("Top 8 finishing order", "Choose the driver you expect in each position.");
    var top = makeRankSelects(topStep, 8, existing && existing.top8, "top-", function () {
      return dnfSelect && dnfSelect.value ? [dnfSelect.value] : [];
    });
    container.appendChild(topStep);

    var flStep = makeStep("Fastest lap", null);
    var flSelect = makeDriverSelect("fastest-lap", existing && existing.fastest_lap, "Choose a driver...");
    flStep.appendChild(makeField("Driver with the fastest lap", flSelect));
    container.appendChild(flStep);

    var dnfStep = makeStep("DNF questions",
      "A DNF is a driver who retires and is not classified as running at the finish. " +
      "Lapped finishers do not count.");
    var choice = el("div", "inline-choice");

    function makeRadio(value, text) {
      var label = document.createElement("label");
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "any-dnf";
      input.value = value;
      label.appendChild(input);
      label.appendChild(document.createTextNode(text));
      choice.appendChild(label);
      return input;
    }

    dnfStep.appendChild(el("p", "", "Will there be at least one DNF?"));
    var yes = makeRadio("yes", "Yes");
    var no = makeRadio("no", "No");
    dnfStep.appendChild(choice);

    var maxDnf = Math.max(1, drivers.length - 8);
    var details = document.createElement("div");
    var countInput = document.createElement("input");
    countInput.type = "number";
    countInput.id = "dnf-count";
    countInput.min = "1";
    countInput.max = String(maxDnf);
    countInput.step = "1";
    if (existing && existing.dnf_count >= 1) { countInput.value = String(existing.dnf_count); }
    details.appendChild(makeField("How many drivers will DNF?", countInput));

    dnfSelect = makeDriverSelect("dnf-driver", existing && existing.dnf_driver, "No pick (skip this question)");
    details.appendChild(makeField("Which driver will DNF? (optional)", dnfSelect));
    details.appendChild(el("p", "step-hint",
      "A driver who retires cannot also finish in your top 8, so your top-8 drivers are not offered here. " +
      "Your DNF driver scores 4 points, or 8 if that driver started in the real top 8."));
    dnfStep.appendChild(details);
    container.appendChild(dnfStep);

    if (existing && existing.any_dnf === true) { yes.checked = true; }
    if (existing && existing.any_dnf === false) { no.checked = true; }

    function syncDetails() { details.hidden = !yes.checked; }
    yes.addEventListener("change", syncDetails);
    no.addEventListener("change", syncDetails);
    syncDetails();

    // Keep the DNF menu and the top-8 menus consistent with each other.
    function syncDnfOptions() {
      var chosen = top.values();
      if (dnfSelect.value && chosen.indexOf(dnfSelect.value) !== -1) { dnfSelect.value = ""; }
      Array.prototype.forEach.call(dnfSelect.options, function (opt) {
        opt.disabled = opt.value !== "" && chosen.indexOf(opt.value) !== -1;
      });
    }
    topStep.addEventListener("change", syncDnfOptions);
    dnfSelect.addEventListener("change", function () { top.sync(); });
    syncDnfOptions();
    top.sync();

    return {
      getPicks: function () {
        var topValues = top.values();
        for (var i = 0; i < topValues.length; i++) {
          if (!topValues[i]) { throw new Error("Please choose a driver for every top-8 position."); }
        }
        if (!flSelect.value) { throw new Error("Please choose the fastest lap driver."); }
        if (!yes.checked && !no.checked) { throw new Error("Please answer the DNF question."); }

        var anyDnf = yes.checked;
        var count = 0;
        var dnfDriver = null;
        if (anyDnf) {
          count = parseInt(countInput.value, 10);
          if (!(count >= 1) || count > maxDnf) {
            throw new Error("Enter how many drivers will DNF (1 to " + maxDnf + ").");
          }
          dnfDriver = dnfSelect.value || null;
          if (dnfDriver && topValues.indexOf(dnfDriver) !== -1) {
            throw new Error("A driver cannot be both in your top 8 and your DNF pick.");
          }
        }

        return {
          top8: topValues,
          fastest_lap: flSelect.value,
          any_dnf: anyDnf,
          dnf_count: count,
          dnf_driver: dnfDriver
        };
      }
    };
  }

  // ---------- Sprint ----------

  function buildSprint(container, existing) {
    var topStep = makeStep("Top 8 finishing order", "Choose the driver you expect in each position.");
    var top = makeRankSelects(topStep, 8, existing && existing.top8, "top-");
    container.appendChild(topStep);

    return {
      getPicks: function () {
        var values = top.values();
        for (var i = 0; i < values.length; i++) {
          if (!values[i]) { throw new Error("Please choose a driver for every position."); }
        }
        return { top8: values };
      }
    };
  }

  function buildForm(type, existing) {
    fieldsEl.textContent = "";
    fieldsEl.appendChild(el("p", "points-note", NOTES[type]));
    if (type === "qualifying" || type === "sprint_qualifying") {
      return buildQualifying(fieldsEl, existing, type === "qualifying" ? "Q" : "SQ");
    }
    if (type === "race") { return buildRace(fieldsEl, existing); }
    return buildSprint(fieldsEl, existing);
  }

  // ---------- loading ----------

  function loadSession(sessionId) {
    var token = ++loadToken;
    var w = windowsById[sessionId];
    var ev = eventsById[w.event_id];

    lockInfo.textContent = "Locks " +
      new Date(w.lock_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) +
      " (your local time). You can change your picks until then.";
    fieldsEl.textContent = "";
    saveButton.disabled = true;
    controller = null;

    return Promise.all([
      client.from("drivers").select("id, code, full_name, team_name")
        .eq("season", ev.season).eq("is_active", true).order("code"),
      client.from("predictions").select("picks")
        .eq("user_id", user.id).eq("session_id", sessionId).limit(1)
    ]).then(function (results) {
      if (token !== loadToken) { return; }
      var driversResult = results[0];
      var existingResult = results[1];
      if (driversResult.error) { throw driversResult.error; }
      if (existingResult.error) { throw existingResult.error; }

      drivers = driversResult.data || [];
      if (drivers.length === 0) {
        setMessage("error", "The driver list for this season has not been loaded yet.");
        return;
      }
      setMessage("", "");

      var existing = existingResult.data && existingResult.data[0]
        ? existingResult.data[0].picks
        : null;
      try {
        controller = buildForm(w.target_type, existing);
      } catch (err) {
        setMessage("error", err.message);
        return;
      }
      saveButton.disabled = false;
    });
  }

  function loadWindows(keepId) {
    return Promise.all([
      client.from("prediction_windows").select("session_id, event_id, target_type, lock_at")
        .eq("is_open", true),
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
      list.sort(function (a, b) {
        var diff = new Date(a.lock_at) - new Date(b.lock_at);
        if (diff !== 0) { return diff; }
        return TYPE_ORDER[a.target_type] - TYPE_ORDER[b.target_type];
      });

      sessionSelect.textContent = "";
      list.forEach(function (w) {
        windowsById[w.session_id] = w;
        sessionSelect.appendChild(makeOption(
          w.session_id,
          eventsById[w.event_id].name + " - " + TYPE_LABEL[w.target_type]
        ));
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
    if (!sessionId || !windowsById[sessionId] || !controller) { return; }

    var picks;
    try {
      picks = controller.getPicks();
    } catch (err) {
      setMessage("error", err.message);
      return;
    }

    saveButton.disabled = true;
    setMessage("", "Saving...");
    client.rpc("submit_prediction", { p_session_id: sessionId, p_picks: picks }).then(function (result) {
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