(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};

  function byId(id) { return document.getElementById(id); }

  var gate = byId("gate");
  var gateText = byId("gate-text");
  var panel = byId("admin-panel");
  var messageEl = byId("admin-message");
  var updatedEl = byId("updated");
  var refreshButton = byId("refresh-button");
  var pendingList = byId("pending-list");
  var pendingEmpty = byId("pending-empty");
  var missingList = byId("missing-list");
  var missingEmpty = byId("missing-empty");
  var recentList = byId("recent-list");
  var logBody = byId("log-body");

  var TYPE_LABEL = {
    qualifying: "Qualifying",
    sprint_qualifying: "Sprint Qualifying",
    race: "Race",
    sprint: "Sprint"
  };

  var driverNames = {};
  var driversBySeason = {};
  var busy = false;
  var editorSeq = 0;

  function setMessage(kind, text) {
    messageEl.className = "message" + (kind ? " " + kind : "");
    messageEl.textContent = text || "";
  }

  function showGate(text) {
    gateText.textContent = text;
    gate.hidden = false;
    panel.hidden = true;
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

  function nameOf(id) {
    return driverNames[id] || String(id);
  }

  function localTime(iso) {
    if (!iso) { return ""; }
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function canonical(value) {
    if (Array.isArray(value)) {
      return "[" + value.map(canonical).join(",") + "]";
    }
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function (k) {
        return JSON.stringify(k) + ":" + canonical(value[k]);
      }).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  function badge(text, kind) {
    return el("span", "badge" + (kind ? " " + kind : ""), text);
  }

  function renderList(ids, ordered) {
    var list = el(ordered ? "ol" : "ul", "result-list");
    (ids || []).forEach(function (id) { list.appendChild(el("li", "", nameOf(id))); });
    return list;
  }

  function block(title, node) {
    var box = el("div", "result-block");
    box.appendChild(el("h4", "", title));
    box.appendChild(node);
    return box;
  }

  function partOf(type) {
    return type === "sprint_qualifying" ? "SQ" : "Q";
  }

  function renderData(type, data) {
    var wrap = el("div", "result-data");
    var part = partOf(type);

    if (type === "qualifying" || type === "sprint_qualifying") {
      wrap.appendChild(block("Reached " + part + "3 (order)", renderList(data.q3_order, true)));
      wrap.appendChild(block("Out in " + part + "2", renderList(data.q2_out, false)));
      wrap.appendChild(block("Out in " + part + "1", renderList(data.q1_out, false)));
    } else if (type === "race") {
      wrap.appendChild(block("Top 8 finish", renderList(data.top8, true)));
      wrap.appendChild(block("Fastest lap", el("p", "", nameOf(data.fastest_lap))));
      var dnfs = data.dnf_drivers || [];
      wrap.appendChild(block(
        "DNF drivers (" + dnfs.length + ")",
        dnfs.length ? renderList(dnfs, false) : el("p", "", "None")
      ));
      wrap.appendChild(block("Real starting grid (top 8)", renderList(data.grid_top8, true)));
    } else {
      wrap.appendChild(block("Top 8 finish", renderList(data.top8, true)));
    }
    return wrap;
  }

  // ---------- editor ----------

  function makeOption(value, text) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    return opt;
  }

  function driverLabel(d) {
    return d.code + " - " + d.full_name;
  }

  function makeSelect(id, list, value, blankText) {
    var select = document.createElement("select");
    select.id = id;
    select.appendChild(makeOption("", blankText));
    list.forEach(function (d) { select.appendChild(makeOption(d.id, driverLabel(d))); });
    if (value) { select.value = value; }
    return select;
  }

  function field(labelText, control) {
    var wrap = el("div", "field");
    var label = el("label", "", labelText);
    label.setAttribute("for", control.id);
    wrap.appendChild(label);
    wrap.appendChild(control);
    return wrap;
  }

  // Selects where no driver can be chosen twice. getBlocked() can add more drivers that are not allowed.
  function rankGroup(container, list, labels, values, prefix, getBlocked, onChange) {
    var selects = [];

    function sync() {
      var used = {};
      selects.forEach(function (s) { if (s.value) { used[s.value] = true; } });
      var blocked = getBlocked ? getBlocked() : [];
      selects.forEach(function (s) {
        Array.prototype.forEach.call(s.options, function (opt) {
          if (opt.value === "") { opt.disabled = false; return; }
          var taken = used[opt.value] === true && opt.value !== s.value;
          opt.disabled = taken || blocked.indexOf(opt.value) !== -1;
        });
      });
      if (onChange) { onChange(); }
    }

    labels.forEach(function (label, i) {
      var select = makeSelect(prefix + i, list, values && values[i], "Choose a driver...");
      select.addEventListener("change", sync);
      selects.push(select);
      container.appendChild(field(label, select));
    });
    sync();

    return {
      values: function () { return selects.map(function (s) { return s.value; }); },
      sync: sync
    };
  }

  function numbered(prefix, count) {
    var labels = [];
    for (var i = 1; i <= count; i++) { labels.push(prefix + i); }
    return labels;
  }

  function buildQualiEditor(root, list, data, type, uid) {
    var part = partOf(type);
    var labels = numbered(part + "3 P", 10).concat(numbered("Out in " + part + "2 #", 6));
    var initial = ((data && data.q3_order) || []).concat((data && data.q2_out) || []);

    var summary = el("p", "step-hint", "");
    var grid = el("div", "editor-grid");
    var group = rankGroup(grid, list, labels, initial, uid + "q", null, function () {
      var chosen = group ? group.values().filter(Boolean) : [];
      var rest = list.filter(function (d) { return chosen.indexOf(d.id) === -1; });
      summary.textContent = "Out in " + part + "1 (" + rest.length + ", filled in automatically): " +
        rest.map(function (d) { return d.code; }).join(", ");
    });
    root.appendChild(grid);
    root.appendChild(summary);
    group.sync();

    return {
      getData: function () {
        var v = group.values();
        for (var i = 0; i < v.length; i++) {
          if (!v[i]) { throw new Error("Please fill in all 16 positions."); }
        }
        var rest = list.filter(function (d) { return v.indexOf(d.id) === -1; }).map(function (d) { return d.id; });
        return { q1_out: rest, q2_out: v.slice(10, 16), q3_order: v.slice(0, 10) };
      }
    };
  }

  function buildRaceEditor(root, list, data, uid) {
    var dnfBoxes = [];
    var countEl = el("p", "step-hint", "");

    root.appendChild(el("h4", "", "Top 8 finishing order"));
    var topGrid = el("div", "editor-grid");
    var top = rankGroup(topGrid, list, numbered("P", 8), data && data.top8, uid + "t", function () {
      return dnfBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    }, function () { syncDnf(); });
    root.appendChild(topGrid);

    var flSelect = makeSelect(uid + "fl", list, data && data.fastest_lap, "Choose a driver...");
    root.appendChild(field("Fastest lap", flSelect));

    root.appendChild(el("h4", "", "DNF drivers"));
    root.appendChild(el("p", "step-hint",
      "Tick every driver who retired. The number of ticked drivers is the DNF count used for scoring. " +
      "A driver in the top 8 cannot be a DNF."));
    var dnfList = el("ul", "check-list");
    var initialDnf = (data && data.dnf_drivers) || [];
    list.forEach(function (d) {
      var li = document.createElement("li");
      var label = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.value = d.id;
      box.checked = initialDnf.indexOf(d.id) !== -1;
      box.addEventListener("change", function () { top.sync(); syncDnf(); });
      dnfBoxes.push(box);
      label.appendChild(box);
      label.appendChild(document.createTextNode(driverLabel(d)));
      li.appendChild(label);
      dnfList.appendChild(li);
    });
    root.appendChild(dnfList);
    root.appendChild(countEl);

    root.appendChild(el("h4", "", "Real starting grid (top 8)"));
    var gridBox = el("div", "editor-grid");
    var grid = rankGroup(gridBox, list, numbered("Grid ", 8), data && data.grid_top8, uid + "g", null, null);
    root.appendChild(gridBox);

    function syncDnf() {
      var chosenTop = top.values();
      var count = 0;
      dnfBoxes.forEach(function (b) {
        var inTop = chosenTop.indexOf(b.value) !== -1;
        if (inTop) { b.checked = false; }
        b.disabled = inTop;
        b.parentNode.className = b.checked ? "checked" : (inTop ? "disabled" : "");
        if (b.checked) { count++; }
      });
      countEl.textContent = "DNF count: " + count;
    }
    syncDnf();
    top.sync();

    return {
      getData: function () {
        var topValues = top.values();
        var gridValues = grid.values();
        for (var i = 0; i < topValues.length; i++) {
          if (!topValues[i]) { throw new Error("Please fill in all 8 finishing positions."); }
        }
        for (var j = 0; j < gridValues.length; j++) {
          if (!gridValues[j]) { throw new Error("Please fill in all 8 starting grid positions."); }
        }
        if (!flSelect.value) { throw new Error("Please choose the fastest lap driver."); }
        var dnf = dnfBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
        return { top8: topValues, fastest_lap: flSelect.value, dnf_drivers: dnf, grid_top8: gridValues };
      }
    };
  }

  function buildSprintEditor(root, list, data, uid) {
    root.appendChild(el("h4", "", "Top 8 finishing order"));
    var gridBox = el("div", "editor-grid");
    var top = rankGroup(gridBox, list, numbered("P", 8), data && data.top8, uid + "s", null, null);
    root.appendChild(gridBox);
    return {
      getData: function () {
        var v = top.values();
        for (var i = 0; i < v.length; i++) {
          if (!v[i]) { throw new Error("Please fill in all 8 positions."); }
        }
        return { top8: v };
      }
    };
  }

  // Opens an editor inside "host". config: { title, type, season, data, saveLabel, save(data) -> promise }
  function openEditor(host, config) {
    host.textContent = "";
    var list = driversBySeason[config.season] || [];
    if (list.length === 0) {
      host.appendChild(el("p", "editor-message error", "No drivers are loaded for this season."));
      return;
    }

    var uid = "ed" + (++editorSeq) + "-";
    var box = el("div", "editor");
    box.appendChild(el("h4", "", config.title));
    var body = document.createElement("div");
    box.appendChild(body);

    var ed;
    if (config.type === "qualifying" || config.type === "sprint_qualifying") {
      ed = buildQualiEditor(body, list, config.data, config.type, uid);
    } else if (config.type === "race") {
      ed = buildRaceEditor(body, list, config.data, uid);
    } else {
      ed = buildSprintEditor(body, list, config.data, uid);
    }

    var msg = el("p", "editor-message", "");
    var actions = el("div", "actions");
    var save = el("button", "btn btn-primary", config.saveLabel);
    save.type = "button";
    var cancel = el("button", "btn", "Cancel");
    cancel.type = "button";
    actions.appendChild(save);
    actions.appendChild(cancel);
    box.appendChild(actions);
    box.appendChild(msg);
    host.appendChild(box);

    cancel.addEventListener("click", function () { host.textContent = ""; });
    save.addEventListener("click", function () {
      if (busy) { return; }
      var data;
      try {
        data = ed.getData();
      } catch (err) {
        msg.className = "editor-message error";
        msg.textContent = err.message;
        return;
      }
      busy = true;
      save.disabled = true;
      msg.className = "editor-message";
      msg.textContent = "Saving...";
      config.save(data).then(function (result) {
        busy = false;
        if (result.error) {
          save.disabled = false;
          msg.className = "editor-message error";
          msg.textContent = result.error.message;
          return;
        }
        setMessage("ok", "Saved as a new pending result. Review it below, then approve it.");
        host.textContent = "";
        return load();
      }).catch(function (err) {
        busy = false;
        save.disabled = false;
        console.error(err);
        msg.className = "editor-message error";
        msg.textContent = "Something went wrong. Please try again.";
      });
    });
  }

  // ---------- actions ----------

  function setButtonsDisabled(disabled) {
    Array.prototype.forEach.call(pendingList.querySelectorAll(".actions button"), function (b) {
      b.disabled = disabled;
    });
  }

  function act(rpcName, item, confirmText, doneText) {
    if (busy) { return; }
    if (!window.confirm(confirmText)) { return; }
    busy = true;
    setButtonsDisabled(true);
    setMessage("", "Working...");
    client.rpc(rpcName, { p_result_id: item.id }).then(function (result) {
      busy = false;
      if (result.error) {
        setMessage("error", result.error.message);
        setButtonsDisabled(false);
        return;
      }
      setMessage("ok", doneText);
      return load();
    }).catch(function (err) {
      busy = false;
      console.error(err);
      setMessage("error", "Something went wrong. Please try again.");
      setButtonsDisabled(false);
    });
  }

  // ---------- rendering ----------

  function renderPending(item) {
    var label = TYPE_LABEL[item.session_type] || item.session_type;
    var card = el("section", "panel admin-card");
    card.appendChild(el("h3", "", item.event_name + " - " + label));

    var badges = el("div", "badges");
    badges.appendChild(badge("Version " + item.version));
    badges.appendChild(badge("Source: " + item.source));
    if (String(item.source).indexOf("derived") !== -1) {
      badges.appendChild(badge("Derived from the sprint grid: verify before approving", "warn"));
    }
    if (String(item.source).indexOf("manual") !== -1) {
      badges.appendChild(badge("Entered or edited by an admin", "warn"));
    }
    badges.appendChild(item.locked
      ? badge("Predictions locked", "ok")
      : badge("Predictions still open: approval is blocked", "bad"));
    badges.appendChild(badge(item.predictions + " prediction(s) will be scored"));
    if (item.approved) {
      var same = canonical(item.approved.data) === canonical(item.data);
      badges.appendChild(badge(
        "Replaces approved version " + item.approved.version + (same ? " (same data)" : " (different data)"),
        same ? "" : "warn"
      ));
    }
    card.appendChild(badges);
    card.appendChild(el("p", "step-hint", "Entered " + localTime(item.entered_at)));
    card.appendChild(renderData(item.session_type, item.data));

    var preview = item.preview || [];
    var previewBox = document.createElement("details");
    previewBox.open = preview.length > 0;
    previewBox.appendChild(el("summary", "", "Score preview if approved (" + preview.length + " player(s))"));
    if (preview.length === 0) {
      previewBox.appendChild(el("p", "step-hint", "Nobody made a prediction for this session."));
    } else {
      var table = el("table", "preview-table");
      preview.forEach(function (row) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", "", row.name));
        tr.appendChild(el("td", "num", row.points + " pts"));
        table.appendChild(tr);
      });
      previewBox.appendChild(table);
    }
    card.appendChild(previewBox);

    if (item.approved) {
      var details = document.createElement("details");
      details.appendChild(el("summary", "", "Show the currently approved result (version " + item.approved.version + ")"));
      details.appendChild(renderData(item.session_type, item.approved.data));
      card.appendChild(details);
    }

    var editorHost = document.createElement("div");

    var actions = el("div", "actions");
    var approve = el("button", "btn btn-primary", "Approve");
    approve.type = "button";
    approve.disabled = !item.locked;
    approve.addEventListener("click", function () {
      act("admin_approve_result", item,
        "Approve this " + label + " result for " + item.event_name + "?\nPoints will be calculated and the leaderboard will update.",
        "Approved. Scores were recalculated.");
    });
    var edit = el("button", "btn", "Edit");
    edit.type = "button";
    edit.addEventListener("click", function () {
      openEditor(editorHost, {
        title: "Edit this result (saved as a new pending version)",
        type: item.session_type,
        season: item.season,
        data: item.data,
        saveLabel: "Save as new pending version",
        save: function (data) {
          return client.rpc("admin_save_result_edit", { p_result_id: item.id, p_data: data });
        }
      });
    });
    var reject = el("button", "btn btn-danger", "Reject");
    reject.type = "button";
    reject.addEventListener("click", function () {
      act("admin_reject_result", item,
        "Reject this " + label + " result for " + item.event_name + "?\nIt will be discarded and will not count.",
        "Rejected.");
    });
    actions.appendChild(approve);
    actions.appendChild(edit);
    actions.appendChild(reject);
    card.appendChild(actions);
    card.appendChild(editorHost);

    return card;
  }

  function renderMissing(item) {
    var label = TYPE_LABEL[item.session_type] || item.session_type;
    var row = el("div", "item-row");
    var line = el("div", "row-line");
    line.appendChild(el("span", "row-text", item.event_name + " - " + label));
    var enter = el("button", "btn btn-small", "Enter result");
    enter.type = "button";
    line.appendChild(enter);
    row.appendChild(line);
    var host = document.createElement("div");
    row.appendChild(host);

    enter.addEventListener("click", function () {
      openEditor(host, {
        title: "Enter the result by hand (saved as a pending result)",
        type: item.session_type,
        season: item.season,
        data: null,
        saveLabel: "Save as pending result",
        save: function (data) {
          return client.rpc("admin_enter_manual_result", { p_session_id: item.session_id, p_data: data });
        }
      });
    });
    return row;
  }

  function renderRecent(item) {
    var label = TYPE_LABEL[item.session_type] || item.session_type;
    var row = el("div", "item-row");
    var line = el("div", "row-line");
    line.appendChild(el("span", "row-text",
      item.event_name + " - " + label + " (version " + item.version + "), approved " +
      localTime(item.approved_at) + (item.approved_by_name ? " by " + item.approved_by_name : "")));
    var correct = el("button", "btn btn-small", "Correct");
    correct.type = "button";
    line.appendChild(correct);
    row.appendChild(line);
    var host = document.createElement("div");
    row.appendChild(host);

    correct.addEventListener("click", function () {
      openEditor(host, {
        title: "Correct this approved result (saved as a new pending version; the current one stays in force until you approve it)",
        type: item.session_type,
        season: item.season,
        data: item.data,
        saveLabel: "Save correction as pending",
        save: function (data) {
          return client.rpc("admin_save_result_edit", { p_result_id: item.id, p_data: data });
        }
      });
    });
    return row;
  }

  function render(overview) {
    var pending = overview.pending || [];
    pendingList.textContent = "";
    pending.forEach(function (item) { pendingList.appendChild(renderPending(item)); });
    pendingEmpty.hidden = pending.length > 0;

    var missing = overview.missing || [];
    missingList.textContent = "";
    missing.forEach(function (item) { missingList.appendChild(renderMissing(item)); });
    missingEmpty.hidden = missing.length > 0;

    recentList.textContent = "";
    (overview.recent || []).forEach(function (item) { recentList.appendChild(renderRecent(item)); });

    logBody.textContent = "";
    (overview.log || []).forEach(function (row) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "", localTime(row.created_at)));
      tr.appendChild(el("td", "", row.event_id || ""));
      tr.appendChild(el("td", "", row.session_type || ""));
      tr.appendChild(el("td", "", row.action || ""));
      var detail = String(row.detail || "");
      var cell = el("td", "", detail.length > 140 ? detail.slice(0, 140) + "..." : detail);
      cell.title = detail;
      tr.appendChild(cell);
      logBody.appendChild(tr);
    });

    updatedEl.textContent = "Updated " + new Date().toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  function load() {
    return client.rpc("admin_overview").then(function (result) {
      if (result.error) { throw result.error; }
      render(result.data || {});
    });
  }

  function handleError(err) {
    console.error(err);
    setMessage("error", "Could not load the admin panel. Please reload the page.");
  }

  refreshButton.addEventListener("click", function () {
    if (busy) { return; }
    load().then(function () { setMessage("", ""); }).catch(handleError);
  });

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) {
      showGate("Please sign in on the Account page.");
      return;
    }
    return client.rpc("is_admin").then(function (adminResult) {
      if (adminResult.error) { throw adminResult.error; }
      if (adminResult.data !== true) {
        showGate("This page is for administrators only.");
        return;
      }
      gate.hidden = true;
      panel.hidden = false;
      return client.from("drivers").select("id, season, code, full_name, is_active").order("code")
        .then(function (drivers) {
          if (drivers.error) { throw drivers.error; }
          (drivers.data || []).forEach(function (d) {
            driverNames[d.id] = d.code + " - " + d.full_name;
            if (!driversBySeason[d.season]) { driversBySeason[d.season] = []; }
            driversBySeason[d.season].push(d);
          });
          return load();
        }).then(function () {
          // Refresh automatically, but never while an editor is open or an action is running.
          setInterval(function () {
            if (!busy && document.visibilityState === "visible" && !document.querySelector(".editor")) {
              load().catch(function (err) { console.error(err); });
            }
          }, 60000);
        });
    });
  }).catch(handleError);
})();