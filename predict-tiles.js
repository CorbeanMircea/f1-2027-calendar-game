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
  var statusEl = byId("pick-status");

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

  // Portrait images. Add entries like "2026-rus": "assets/portraits/rus.webp" once verified images exist.
  // Every portrait gets the same dark, desaturated treatment from tiles.css.
  var PORTRAITS = {};

  // Approximate team colours (to be checked). Matched against the team name.
  var TEAM_COLORS = [
    ["mercedes", "#27f4d2"], ["ferrari", "#e8002d"], ["mclaren", "#ff8000"], ["red bull", "#3671c6"],
    ["haas", "#b6babd"], ["rb f1", "#6692ff"], ["racing bulls", "#6692ff"], ["audi", "#8e949c"],
    ["alpine", "#0093cc"], ["williams", "#64c4ff"], ["cadillac", "#d0d4da"], ["aston", "#229971"]
  ];

  var SILHOUETTE =
    '<svg viewBox="0 0 100 125" aria-hidden="true" focusable="false">' +
    '<path class="sil-body" d="M6 125C6 100 26 91 50 91S94 100 94 125Z"/>' +
    '<path class="sil-helmet" d="M29 54C29 29 38 17 50 17S71 29 71 54C71 72 62 87 50 87S29 72 29 54Z"/>' +
    '<path class="sil-visor" d="M32 47H68V59C61 64 39 64 32 59Z"/>' +
    '<rect class="sil-stripe" x="46" y="17" width="8" height="20"/>' +
    '</svg>';

  var CLOSE_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var user = null;
  var windowsById = {};
  var eventsById = {};
  var drivers = [];
  var controller = null;
  var loadToken = 0;
  var lockMs = null;
  var lockTimer = null;

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

  // ---------- helpers ----------

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

  function lastName(full) {
    var parts = String(full).trim().split(/\s+/);
    return parts[parts.length - 1];
  }

  function teamColor(name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < TEAM_COLORS.length; i++) {
      if (lower.indexOf(TEAM_COLORS[i][0]) !== -1) { return TEAM_COLORS[i][1]; }
    }
    return "#7a7f87";
  }

  function sortedDrivers() {
    return drivers.slice().sort(function (a, b) {
      if (a.team_name !== b.team_name) { return a.team_name < b.team_name ? -1 : 1; }
      return (a.car_number || 0) - (b.car_number || 0);
    });
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

  function isLocked() {
    return lockMs !== null && Date.now() >= lockMs;
  }

  function setStatus(text, kind) {
    if (isLocked()) {
      text = "Predictions locked";
      kind = "locked";
    }
    statusEl.textContent = text || "";
    statusEl.setAttribute("data-kind", kind || "");
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

  // ---------- tiles, grids and lineup slots ----------

  function makeTile(d, onClick) {
    var tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.style.setProperty("--team", teamColor(d.team_name));

    var portrait = el("span", "tile-portrait");
    if (PORTRAITS[d.id]) {
      var img = document.createElement("img");
      img.src = PORTRAITS[d.id];
      img.alt = "";
      img.loading = "lazy";
      portrait.appendChild(img);
    } else {
      portrait.innerHTML = SILHOUETTE;
      portrait.title = "Placeholder portrait";
    }
    tile.appendChild(portrait);

    if (d.car_number) { tile.appendChild(el("span", "tile-number", String(d.car_number))); }
    var badge = el("span", "tile-badge");
    badge.hidden = true;
    tile.appendChild(badge);

    var info = el("span", "tile-info");
    info.appendChild(el("span", "tile-code", d.code));
    info.appendChild(el("span", "tile-name", d.full_name));
    info.appendChild(el("span", "tile-team", d.team_name));
    tile.appendChild(info);

    tile.addEventListener("click", function () { onClick(d.id); });
    tile._badge = badge;
    return tile;
  }

  // gridCfg: { onToggle(id), stateOf(id) -> { selected, saved, blocked, full, badge } }
  function createGrid(list, gridCfg) {
    var wrap = el("div", "tile-grid");
    var tiles = {};
    list.forEach(function (d) {
      tiles[d.id] = makeTile(d, gridCfg.onToggle);
      wrap.appendChild(tiles[d.id]);
    });

    function update() {
      var locked = isLocked();
      list.forEach(function (d) {
        var t = tiles[d.id];
        var s = gridCfg.stateOf(d.id);
        t.classList.toggle("is-selected", !!s.selected && !s.saved);
        t.classList.toggle("is-submitted", !!s.selected && !!s.saved);
        t.classList.toggle("is-blocked", !!s.blocked);
        t.classList.toggle("is-full", !s.selected && !!s.full && !s.blocked);
        t.classList.toggle("is-locked", locked);
        t.disabled = locked || !!s.blocked || (!s.selected && !!s.full);
        t.setAttribute("aria-pressed", s.selected ? "true" : "false");
        t._badge.hidden = !s.selected;
        t._badge.textContent = s.selected ? s.badge : "";
        t.setAttribute("aria-label", d.full_name + ", " + d.team_name +
          (s.selected ? ", selected " + s.badge : "") + (s.blocked ? ", not available" : ""));
      });
    }

    update();
    return { el: wrap, update: update };
  }

  // handlers: { onTap(index), onRemove(index) optional }
  function renderSlots(host, items, count, moving, handlers, focusIndex) {
    host.textContent = "";
    var list = el("ol", "slots");
    var focusTarget = null;
    var locked = isLocked();

    for (var i = 0; i < count; i++) {
      (function (index) {
        var d = items[index] ? driverById(items[index]) : null;
        var li = el("li", "slot-item");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "slot" + (d ? " is-filled" : "") + (moving === index ? " is-moving" : "");
        btn.disabled = !d || locked;
        btn.appendChild(el("span", "slot-pos", "P" + (index + 1)));

        if (d) {
          btn.style.setProperty("--team", teamColor(d.team_name));
          btn.appendChild(el("span", "slot-code", d.code));
          btn.appendChild(el("span", "slot-name", lastName(d.full_name)));
          btn.setAttribute("aria-label", "Position " + (index + 1) + ": " + d.full_name +
            (moving === index ? ". Selected. Choose another position to swap." : ". Choose to move or swap."));
          btn.setAttribute("aria-pressed", moving === index ? "true" : "false");
          btn.addEventListener("click", function () { handlers.onTap(index); });
        } else {
          btn.appendChild(el("span", "slot-name", "Empty"));
          btn.setAttribute("aria-label", "Position " + (index + 1) + ": empty");
        }
        li.appendChild(btn);

        if (d && handlers.onRemove && !locked) {
          var rm = el("button", "slot-remove");
          rm.type = "button";
          rm.innerHTML = CLOSE_ICON;
          rm.setAttribute("aria-label", "Remove " + d.full_name + " from position " + (index + 1));
          rm.addEventListener("click", function () { handlers.onRemove(index); });
          li.appendChild(rm);
        }

        list.appendChild(li);
        if (focusIndex === index && !btn.disabled) { focusTarget = btn; }
      })(i);
    }

    host.appendChild(list);
    if (focusTarget) { focusTarget.focus(); }
  }

  // A picker for "the top N in order": tap tiles to fill the next free position.
  // opts: { count, list, initial, hint, blocked(id), onChange(), isDirty() optional }
  function createPicker(host, opts) {
    var picks = filterKnown(opts.initial).slice(0, opts.count);
    var moving = null;
    var savedJson = null;
    var trayHost = document.createElement("div");
    var grid = null;
    var handlers = null;

    function isSaved() {
      if (opts.isDirty && opts.isDirty()) { return false; }
      return savedJson !== null && JSON.stringify(picks) === savedJson;
    }

    function stateOf(id) {
      var i = picks.indexOf(id);
      return {
        selected: i >= 0,
        saved: i >= 0 && isSaved(),
        blocked: i < 0 && !!opts.blocked(id),
        full: picks.length >= opts.count,
        badge: String(i + 1)
      };
    }

    function refresh(focusIndex) {
      grid.update();
      renderSlots(trayHost, picks, opts.count, moving, handlers, focusIndex);
    }

    function toggle(id) {
      if (isLocked()) { return; }
      var i = picks.indexOf(id);
      if (i >= 0) {
        picks.splice(i, 1);
      } else if (picks.length < opts.count && !opts.blocked(id)) {
        picks.push(id);
      } else {
        return;
      }
      moving = null;
      refresh();
      opts.onChange();
    }

    handlers = {
      onTap: function (i) {
        if (isLocked() || !picks[i]) { return; }
        if (moving === null) {
          moving = i;
        } else if (moving === i) {
          moving = null;
        } else {
          var tmp = picks[moving];
          picks[moving] = picks[i];
          picks[i] = tmp;
          moving = null;
        }
        refresh(i);
        opts.onChange();
      },
      onRemove: function (i) {
        if (isLocked()) { return; }
        picks.splice(i, 1);
        moving = null;
        refresh();
        opts.onChange();
      }
    };

    grid = createGrid(opts.list, { onToggle: toggle, stateOf: stateOf });
    host.appendChild(trayHost);
    host.appendChild(el("p", "step-hint", opts.hint));
    host.appendChild(grid.el);
    refresh();

    return {
      values: function () { return picks.slice(); },
      refresh: function () { refresh(); },
      markSaved: function () { savedJson = JSON.stringify(picks); },
      isSaved: isSaved
    };
  }

  var PICK_HINT = "Tap a driver to add them to the next free position. Tap a position, then another, " +
    "to swap them. Use the cross to remove a pick.";

  // ---------- Sprint ----------

  function buildSprint(container, existing) {
    var list = sortedDrivers();
    var step = makeStep("Top 8 finishing order", null);
    container.appendChild(step);

    var picker = createPicker(step, {
      count: 8,
      list: list,
      initial: existing && existing.top8,
      hint: PICK_HINT,
      blocked: function () { return false; },
      onChange: function () { updateStatus(); }
    });

    function updateStatus() {
      var n = picker.values().length;
      if (n < 8) {
        setStatus(n + " of 8 selected", "progress");
      } else if (picker.isSaved()) {
        setStatus("Prediction saved", "saved");
      } else {
        setStatus("Ready to save", "ready");
      }
    }

    updateStatus();

    return {
      getPicks: function () {
        var values = picker.values();
        if (values.length !== 8) { throw new Error("Please choose a driver for every position."); }
        return { top8: values };
      },
      markSaved: function () { picker.markSaved(); },
      refresh: function () { picker.refresh(); updateStatus(); }
    };
  }

  // ---------- Grand Prix ----------

  function buildRace(container, existing) {
    var list = sortedDrivers();
    var dnfSelect = null;
    var picker = null;
    var extrasJson = null;
    var yes = null;
    var no = null;
    var countInput = null;
    var flSelect = null;

    function extrasSnap() {
      return JSON.stringify([
        flSelect ? flSelect.value : "",
        yes && yes.checked ? "y" : (no && no.checked ? "n" : ""),
        countInput ? countInput.value : "",
        dnfSelect ? dnfSelect.value : ""
      ]);
    }

    function extrasDirty() {
      return extrasJson !== null && extrasSnap() !== extrasJson;
    }

    var topStep = makeStep("Top 8 finishing order", null);
    container.appendChild(topStep);
    picker = createPicker(topStep, {
      count: 8,
      list: list,
      initial: existing && existing.top8,
      hint: PICK_HINT,
      blocked: function (id) { return !!(dnfSelect && dnfSelect.value === id); },
      isDirty: extrasDirty,
      onChange: function () { syncDnfOptions(); updateStatus(); }
    });

    var flStep = makeStep("Fastest lap", null);
    flSelect = makeDriverSelect("fastest-lap", existing && existing.fastest_lap, "Choose a driver...");
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
    yes = makeRadio("yes", "Yes");
    no = makeRadio("no", "No");
    dnfStep.appendChild(choice);

    var maxDnf = Math.max(1, drivers.length - 8);
    var details = document.createElement("div");
    countInput = document.createElement("input");
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

    function syncDnfOptions() {
      var chosen = picker.values();
      if (dnfSelect.value && chosen.indexOf(dnfSelect.value) !== -1) { dnfSelect.value = ""; }
      Array.prototype.forEach.call(dnfSelect.options, function (opt) {
        opt.disabled = opt.value !== "" && chosen.indexOf(opt.value) !== -1;
      });
    }

    function savedAll() {
      return picker.isSaved() && extrasJson !== null && extrasSnap() === extrasJson;
    }

    function updateStatus() {
      var n = picker.values().length;
      if (n < 8) {
        setStatus(n + " of 8 selected", "progress");
      } else if (savedAll()) {
        setStatus("Prediction saved", "saved");
      } else {
        setStatus("Ready to save", "ready");
      }
    }

    function syncDetails() {
      details.hidden = !yes.checked;
      if (!yes.checked) { dnfSelect.value = ""; }
    }

    function updateAll() {
      syncDetails();
      syncDnfOptions();
      picker.refresh();
      updateStatus();
    }

    yes.addEventListener("change", updateAll);
    no.addEventListener("change", updateAll);
    flSelect.addEventListener("change", updateAll);
    countInput.addEventListener("input", updateAll);
    dnfSelect.addEventListener("change", updateAll);

    updateAll();

    return {
      getPicks: function () {
        var topValues = picker.values();
        if (topValues.length !== 8) { throw new Error("Please choose a driver for every top-8 position."); }
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
      },
      markSaved: function () {
        picker.markSaved();
        extrasJson = extrasSnap();
      },
      refresh: updateAll
    };
  }

  // ---------- Qualifying and Sprint Qualifying ----------

  function buildQualifying(container, existing, part) {
    var list = sortedDrivers();
    var q1Size = list.length - 16;
    if (q1Size < 1) {
      throw new Error("The driver list for this season is not complete yet.");
    }

    var q1 = filterKnown(existing && existing.q1_out);
    var q2 = filterKnown(existing && existing.q2_out);
    var order = filterKnown(existing && existing.q3_order);
    var moving = null;
    var savedJson = null;

    function snap() {
      return JSON.stringify({ a: q1.slice().sort(), b: q2.slice().sort(), c: order });
    }

    function isSaved() {
      return savedJson !== null && snap() === savedJson;
    }

    var step1 = el("div", "form-step");
    var step2 = el("div", "form-step");
    var step3 = el("div", "form-step");
    container.appendChild(step1);
    container.appendChild(step2);
    container.appendChild(step3);

    function counterEl() { return el("span", "counter", ""); }
    function setCounter(node, count, size) {
      node.textContent = count + " / " + size;
      node.className = "counter" + (count === size ? " done" : "");
    }

    // Step 1: built once, only updated afterwards.
    var h1 = el("h3", "", "Step 1: knocked out in " + part + "1");
    var c1 = counterEl();
    h1.appendChild(c1);
    step1.appendChild(h1);
    step1.appendChild(el("p", "step-hint",
      "Choose the " + q1Size + " drivers you think will be eliminated in " + part + "1."));

    function toggleOut(arr, id, size) {
      if (isLocked()) { return; }
      var i = arr.indexOf(id);
      if (i >= 0) {
        arr.splice(i, 1);
      } else if (arr.length < size) {
        arr.push(id);
      } else {
        return;
      }
      moving = null;
      render();
    }

    var grid1 = createGrid(list, {
      onToggle: function (id) { toggleOut(q1, id, q1Size); },
      stateOf: function (id) {
        var sel = q1.indexOf(id) >= 0;
        return { selected: sel, saved: sel && isSaved(), full: q1.length >= q1Size, badge: "Out" };
      }
    });
    step1.appendChild(grid1.el);

    // Step 2: rebuilt only when the set of remaining drivers changes.
    var h2 = el("h3", "", "Step 2: knocked out in " + part + "2");
    var c2 = counterEl();
    h2.appendChild(c2);
    var hint2 = el("p", "step-hint", "");
    var holder2 = document.createElement("div");
    step2.appendChild(h2);
    step2.appendChild(hint2);
    step2.appendChild(holder2);
    var grid2 = null;
    var grid2Key = "";

    // Step 3: order of the drivers who reach Q3.
    var h3 = el("h3", "", "Step 3: " + part + "3 order (P1 to P10)");
    var hint3 = el("p", "step-hint", "");
    var slotsHost = document.createElement("div");
    step3.appendChild(h3);
    step3.appendChild(hint3);
    step3.appendChild(slotsHost);

    var orderHandlers = {
      onTap: function (i) {
        if (isLocked() || !order[i]) { return; }
        if (moving === null) {
          moving = i;
        } else if (moving === i) {
          moving = null;
        } else {
          var tmp = order[moving];
          order[moving] = order[i];
          order[i] = tmp;
          moving = null;
        }
        render(i);
      }
    };

    function updateStatus() {
      if (q1.length < q1Size) {
        setStatus("Step 1: " + q1.length + " of " + q1Size + " chosen", "progress");
      } else if (q2.length < 6) {
        setStatus("Step 2: " + q2.length + " of 6 chosen", "progress");
      } else if (isSaved()) {
        setStatus("Prediction saved", "saved");
      } else {
        setStatus("Ready to save", "ready");
      }
    }

    function render(focusIndex) {
      q2 = q2.filter(function (id) { return q1.indexOf(id) === -1; });

      var step1Done = q1.length === q1Size;
      var rest = list.filter(function (d) { return q1.indexOf(d.id) === -1; });
      var step2Done = step1Done && q2.length === 6;

      var q3ids = step2Done
        ? rest.filter(function (d) { return q2.indexOf(d.id) === -1; }).map(function (d) { return d.id; })
        : [];
      order = order.filter(function (id) { return q3ids.indexOf(id) !== -1; });
      q3ids.forEach(function (id) { if (order.indexOf(id) === -1) { order.push(id); } });

      setCounter(c1, q1.length, q1Size);
      grid1.update();

      if (!step1Done) {
        c2.hidden = true;
        hint2.textContent = "Complete step 1 first.";
        holder2.textContent = "";
        grid2 = null;
        grid2Key = "";
      } else {
        c2.hidden = false;
        setCounter(c2, q2.length, 6);
        hint2.textContent = "From the remaining " + rest.length + " drivers, choose the 6 eliminated in " + part + "2.";
        var key = rest.map(function (d) { return d.id; }).join(",");
        if (key !== grid2Key) {
          holder2.textContent = "";
          grid2 = createGrid(rest, {
            onToggle: function (id) { toggleOut(q2, id, 6); },
            stateOf: function (id) {
              var sel = q2.indexOf(id) >= 0;
              return { selected: sel, saved: sel && isSaved(), full: q2.length >= 6, badge: "Out" };
            }
          });
          holder2.appendChild(grid2.el);
          grid2Key = key;
        }
        grid2.update();
      }

      if (!step2Done) {
        hint3.textContent = "Complete step 2 first.";
        slotsHost.textContent = "";
      } else {
        hint3.textContent = "These 10 drivers reach " + part + "3. Tap a position, then another, to swap them.";
        renderSlots(slotsHost, order, 10, moving, orderHandlers, focusIndex);
      }

      updateStatus();
    }

    render();

    return {
      getPicks: function () {
        if (q1.length !== q1Size || q2.length !== 6 || order.length !== 10) {
          throw new Error("Please complete all three steps.");
        }
        return { q1_out: q1.slice(), q2_out: q2.slice(), q3_order: order.slice() };
      },
      markSaved: function () { savedJson = snap(); },
      refresh: function () { render(); }
    };
  }

  function buildForm(type, existing) {
    fieldsEl.textContent = "";
    fieldsEl.appendChild(el("p", "points-note", NOTES[type]));
    fieldsEl.appendChild(el("p", "portrait-note",
      "Portraits are placeholders until verified images are added."));
    if (type === "qualifying" || type === "sprint_qualifying") {
      return buildQualifying(fieldsEl, existing, type === "qualifying" ? "Q" : "SQ");
    }
    if (type === "race") { return buildRace(fieldsEl, existing); }
    return buildSprint(fieldsEl, existing);
  }

  // ---------- locking ----------

  function onLocked() {
    saveButton.disabled = true;
    if (controller) { controller.refresh(); }
    setStatus("Predictions locked", "locked");
    setMessage("", "Predictions are locked for this session. Your saved picks cannot be changed.");
  }

  function scheduleLockCheck() {
    window.clearTimeout(lockTimer);
    if (lockMs === null) { return; }
    var wait = lockMs - Date.now();
    if (wait <= 0) {
      onLocked();
      return;
    }
    lockTimer = window.setTimeout(scheduleLockCheck, Math.min(wait + 50, 30000));
  }

  // ---------- loading ----------

  function loadSession(sessionId) {
    var token = ++loadToken;
    var w = windowsById[sessionId];
    var ev = eventsById[w.event_id];

    window.clearTimeout(lockTimer);
    lockMs = w.lock_at ? Date.parse(w.lock_at) : null;

    lockInfo.textContent = "Locks " +
      new Date(w.lock_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) +
      " (your local time). You can change your picks until then.";
    fieldsEl.textContent = "";
    saveButton.disabled = true;
    controller = null;
    setStatus("", "");

    return Promise.all([
      client.from("drivers").select("id, code, full_name, team_name, car_number")
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
      if (existing) { controller.markSaved(); }
      controller.refresh();
      saveButton.disabled = isLocked();
      scheduleLockCheck();
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
      saveButton.disabled = isLocked();
      if (result.error) {
        setMessage("error", result.error.message);
        if (result.error.message.indexOf("closed") !== -1) {
          loadWindows(null).catch(handleLoadError);
        }
        return;
      }
      controller.markSaved();
      controller.refresh();
      setMessage("ok", "Prediction saved. You can change it until the lock time.");
    }).catch(function (err) {
      saveButton.disabled = isLocked();
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