// Lights Out: notifications card on the Predictions page (Milestone M5).
// Shows the informational notices created when an admin registers a driver substitution or a grid penalty (or changes one)
// for a session the player saved a prediction for. Reads player_notifications (own rows only) and marks notices as read with
// the database function mark_notifications_read. It never changes a prediction and nothing here needs an answer.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var card = document.getElementById("notices-card");
  if (!card) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var els = {
    count: document.getElementById("nt-count"),
    list: document.getElementById("nt-list"),
    all: document.getElementById("nt-all"),
    more: document.getElementById("nt-more")
  };

  var SESSION_LABELS = {
    sprint_qualifying: "Sprint Qualifying",
    sprint: "Sprint",
    qualifying: "Qualifying",
    race: "Race"
  };

  var state = { rows: [], showRead: false, busy: false };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function stamp(iso) {
    return new Date(iso).toLocaleString([], {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function sessionName(type) { return SESSION_LABELS[type] || type; }

  function joinList(items) {
    var names = (items || []).map(sessionName);
    if (names.length <= 1) { return names.join(""); }
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  function driverText(d) {
    return d ? (d.code + " " + d.name) : "a driver";
  }

  function positionsText(p) {
    if (p.original_position && p.adjusted_position) { return " (from P" + p.original_position + " to P" + p.adjusted_position + ")"; }
    if (p.adjusted_position) { return " (starts P" + p.adjusted_position + ")"; }
    return "";
  }

  function penaltyText(p) {
    if (!p) { return "a grid penalty"; }
    var what = p.type === "places" ? p.places + "-place grid penalty"
      : (p.type === "pit_lane" ? "pit-lane start" : "start from the back of the grid");
    return what + positionsText(p);
  }

  var KEEP = "Your saved prediction stays saved and still counts, whatever you decide.";
  var PENALTY_NOTE = "A grid penalty changes the starting grid only. Your prediction and the scoring are not affected.";

  // The text of one notification, built from what was recorded when it was created.
  function describe(n) {
    var p = n.payload || {};
    var gp = p.grand_prix || "Grand Prix";
    var mine = p.your_sessions && p.your_sessions.length ? " You saved a prediction for the " + joinList(p.your_sessions) + "." : "";

    if (n.kind === "substitution") {
      return {
        title: "Driver change: " + gp,
        body: driverText(p.out) + " is replaced by " + driverText(p.in) + " for the " + joinList(p.sessions) + "." + mine + " " + KEEP
      };
    }
    if (n.kind === "substitution_reverted") {
      return {
        title: "Driver change reverted: " + gp,
        body: "The replacement of " + driverText(p.out) + " by " + driverText(p.in) + " was reverted for the " +
          joinList(p.sessions) + "." + (p.reason ? " Reason: " + p.reason + "." : "") + mine + " " + KEEP
      };
    }
    if (n.kind === "grid_penalty") {
      return {
        title: "Grid penalty: " + gp + " (" + sessionName(p.session) + ")",
        body: driverText(p.driver) + ": " + penaltyText(p.penalty) + ". " +
          (p.penalty && p.penalty.reason ? p.penalty.reason + ". " : "") + PENALTY_NOTE
      };
    }
    if (n.kind === "grid_penalty_revoked") {
      return {
        title: "Grid penalty withdrawn: " + gp + " (" + sessionName(p.session) + ")",
        body: "The penalty for " + driverText(p.driver) + " (" + penaltyText(p.penalty) + ") was withdrawn." +
          (p.reason ? " Reason: " + p.reason + "." : "") + " " + PENALTY_NOTE
      };
    }
    if (n.kind === "grid_penalty_updated") {
      return {
        title: "Grid penalty corrected: " + gp + " (" + sessionName(p.session) + ")",
        body: driverText(p.driver) + " now has: " + penaltyText(p.penalty) + ". Before: " + penaltyText(p.previous) + "." +
          (p.penalty && p.penalty.reason ? " " + p.penalty.reason + "." : "") + " " + PENALTY_NOTE
      };
    }
    return { title: "Update: " + gp, body: "There is an update for this weekend. " + KEEP };
  }

  function unreadCount() {
    return state.rows.filter(function (r) { return !r.read_at; }).length;
  }

  function render() {
    var unread = unreadCount();
    var readCount = state.rows.length - unread;

    if (unread === 0 && !state.showRead) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    els.count.textContent = unread > 0 ? "(" + unread + " new)" : "";
    els.all.hidden = unread < 2;

    els.list.textContent = "";
    state.rows.forEach(function (n) {
      var isRead = !!n.read_at;
      if (isRead && !state.showRead) { return; }
      var d = describe(n);
      var item = el("div", "nt-item" + (isRead ? " is-read" : ""));
      item.appendChild(el("p", "nt-title", d.title));
      item.appendChild(el("p", "nt-body", d.body));
      var when = (n.payload && n.payload.registered_at) || n.created_at;
      item.appendChild(el("p", "nt-meta", "Registered " + stamp(when)));
      if (!isRead) {
        var got = el("button", "btn btn-small", "Got it");
        got.type = "button";
        got.addEventListener("click", function () { markRead([n.id]); });
        item.appendChild(got);
      }
      els.list.appendChild(item);
    });

    if (readCount > 0) {
      els.more.hidden = false;
      els.more.textContent = state.showRead ? "Hide earlier notifications" : "Show earlier notifications (" + readCount + ")";
    } else {
      els.more.hidden = true;
    }
  }

  function markRead(ids) {
    if (state.busy) { return; }
    state.busy = true;
    client.rpc("mark_notifications_read", { p_ids: ids }).then(function (res) {
      state.busy = false;
      if (res.error) { throw res.error; }
      var now = new Date().toISOString();
      state.rows.forEach(function (r) {
        if (!r.read_at && (ids === null || ids.indexOf(r.id) !== -1)) { r.read_at = now; }
      });
      render();
      window.dispatchEvent(new Event("lo-notices-changed"));
    }).catch(function (err) {
      state.busy = false;
      console.error(err);
    });
  }

  els.all.addEventListener("click", function () { markRead(null); });
  els.more.addEventListener("click", function () {
    state.showRead = !state.showRead;
    render();
  });

  function load() {
    return client.from("player_notifications")
      .select("id, kind, payload, created_at, read_at")
      .order("created_at", { ascending: false }).limit(40)
      .then(function (res) {
        if (res.error) { throw res.error; }
        state.rows = res.data || [];
        render();
      });
  }

  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) { return; }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !state.busy) { load().catch(function (err) { console.error(err); }); }
    });
    return load();
  }).catch(function (err) { console.error(err); });
})();
