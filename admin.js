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
  var recentList = byId("recent-list");
  var logBody = byId("log-body");

  var TYPE_LABEL = {
    qualifying: "Qualifying",
    sprint_qualifying: "Sprint Qualifying",
    race: "Race",
    sprint: "Sprint"
  };

  var driverNames = {};
  var busy = false;

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

  function renderData(type, data) {
    var wrap = el("div", "result-data");
    var part = type === "sprint_qualifying" ? "SQ" : "Q";

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

  function setButtonsDisabled(disabled) {
    Array.prototype.forEach.call(pendingList.querySelectorAll("button"), function (b) {
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

    if (item.approved) {
      var details = document.createElement("details");
      details.appendChild(el("summary", "", "Show the currently approved result (version " + item.approved.version + ")"));
      details.appendChild(renderData(item.session_type, item.approved.data));
      card.appendChild(details);
    }

    var actions = el("div", "actions");
    var approve = el("button", "btn btn-primary", "Approve");
    approve.type = "button";
    approve.disabled = !item.locked;
    approve.addEventListener("click", function () {
      act("admin_approve_result", item,
        "Approve this " + label + " result for " + item.event_name + "?\nPoints will be calculated and the leaderboard will update.",
        "Approved. Scores were recalculated.");
    });
    var reject = el("button", "btn btn-danger", "Reject");
    reject.type = "button";
    reject.addEventListener("click", function () {
      act("admin_reject_result", item,
        "Reject this " + label + " result for " + item.event_name + "?\nIt will be discarded and will not count.",
        "Rejected.");
    });
    actions.appendChild(approve);
    actions.appendChild(reject);
    card.appendChild(actions);

    return card;
  }

  function render(overview) {
    var pending = overview.pending || [];
    pendingList.textContent = "";
    pending.forEach(function (item) { pendingList.appendChild(renderPending(item)); });
    pendingEmpty.hidden = pending.length > 0;

    recentList.textContent = "";
    (overview.recent || []).forEach(function (item) {
      var label = TYPE_LABEL[item.session_type] || item.session_type;
      recentList.appendChild(el("li", "",
        item.event_name + " - " + label + " (version " + item.version + "), approved " + localTime(item.approved_at)));
    });

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
      return client.from("drivers").select("id, code, full_name").then(function (drivers) {
        if (drivers.error) { throw drivers.error; }
        (drivers.data || []).forEach(function (d) {
          driverNames[d.id] = d.code + " - " + d.full_name;
        });
        return load();
      }).then(function () {
        setInterval(function () {
          if (!busy && document.visibilityState === "visible") {
            load().catch(function (err) { console.error(err); });
          }
        }, 60000);
      });
    });
  }).catch(handleError);
})();