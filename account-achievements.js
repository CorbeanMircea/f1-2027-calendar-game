// Lights Out: achievements section on the Account page.
// Reads the read-only view player_achievements (migration 024) and draws the badges from
// lo-achievements.js. It wraps AccountProfile.render/clear, so account.js is untouched.
(function () {
  "use strict";

  var card = document.getElementById("ach-card");
  var AP = window.AccountProfile;
  var A = window.LO_ACH;
  if (!card || !AP || !A) { return; }

  var $ = function (id) { return document.getElementById(id); };
  var els = { count: $("ach-count"), state: $("ach-state"), grid: $("ach-grid") };
  var state = { client: null, user: null, token: 0 };

  function fmt(n) { return Number(n).toLocaleString("en-GB"); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function showState(text) {
    els.state.textContent = text || "";
    els.state.hidden = !text;
  }

  // Levels seen on the last visit, per player and per device: used for the "New" marker.
  function loadSeen(uid) {
    try {
      var raw = window.localStorage.getItem("lo-ach-" + uid);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveSeen(uid, map) {
    try { window.localStorage.setItem("lo-ach-" + uid, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  function cardFor(def, r, isNew) {
    var locked = r.level === 0;
    var li = el("li", "ach-card" + (locked ? " is-locked" : ""));

    if (isNew) {
      var mark = el("span", "ach-new");
      mark.appendChild(el("i"));
      mark.appendChild(document.createTextNode("New"));
      li.appendChild(mark);
    }

    var art = el("div", "ach-art");
    art.setAttribute("aria-hidden", "true");
    art.innerHTML = A.badgeSvg(def.key, locked ? 1 : r.step, locked, 88);
    li.appendChild(art);

    li.appendChild(el("h3", "ach-name", def.name));
    li.appendChild(el("p", "ach-level", locked ? "Locked" : "Level " + r.level + " of " + r.max_level));

    var maxed = r.next_target === null || r.next_target === undefined;
    var pct = maxed ? 100 : Math.max(0, Math.min(100, Math.round((100 * r.progress) / r.next_target)));
    var bar = el("div", "ach-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", def.name + " progress");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(pct));
    var fill = el("span", "ach-fill");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    li.appendChild(bar);

    li.appendChild(el("p", "ach-meta", maxed
      ? fmt(r.progress) + " " + def.unit + " \u00b7 maximum level"
      : fmt(r.progress) + " of " + fmt(r.next_target) + " " + def.unit));

    if (!locked && r.earned_round) {
      li.appendChild(el("p", "ach-earned", "Level " + r.level + " reached in R" + r.earned_round + " \u00b7 " + r.earned_event));
    }
    return li;
  }

  function render(rows, uid) {
    var seen = loadSeen(uid);
    var map = {};
    var shown = 0;
    var unlocked = 0;
    els.grid.textContent = "";

    rows.forEach(function (r) {
      var def = A.BY_KEY[r.achievement];
      if (!def) { return; }
      shown++;
      map[r.achievement] = r.level;
      if (r.level > 0) { unlocked++; }
      var isNew = !!seen && r.level > (seen[r.achievement] || 0);
      els.grid.appendChild(cardFor(def, r, isNew));
    });

    saveSeen(uid, map);
    els.count.textContent = unlocked + " of " + shown + " unlocked";
  }

  function failure(err) {
    console.error(err);
    var text = (err && (err.message || "")) + " " + ((err && err.code) || "");
    els.grid.textContent = "";
    els.count.textContent = "";
    showState(/does not exist|schema cache|PGRST20[0-9]|42P01/i.test(text)
      ? "Achievements need the latest database update (024_player_achievements.sql)."
      : "Could not load achievements. Please reload the page.");
  }

  function start(client, user) {
    state.client = client;
    state.user = user;
    state.token++;
    var token = state.token;
    card.hidden = false;
    els.grid.textContent = "";
    els.count.textContent = "";
    showState("Loading achievements...");

    var COLUMNS = "achievement, sort_order, progress, level, max_level, step, next_target, next_step, earned_season, earned_round, earned_event";
    function query(view) {
      return client.from(view).select(COLUMNS).eq("user_id", user.id).order("sort_order", { ascending: true });
    }

    // player_achievements_all (migration 029) adds Title Caller. If it is not there yet, use the original 13.
    query("player_achievements_all")
      .then(function (first) {
        if (first.error && /does not exist|schema cache|PGRST20[0-9]|42P01/i.test((first.error.message || "") + " " + (first.error.code || ""))) {
          return query("player_achievements");
        }
        return first;
      })
      .then(function (res) {
        if (token !== state.token) { return; }
        if (res.error) { return failure(res.error); }
        var rows = res.data || [];
        if (rows.length === 0) {
          showState("Achievements start after your first scored session.");
          return;
        }
        showState("");
        render(rows, user.id);
      }).catch(failure);
  }

  function clear() {
    state.token++;
    state.user = null;
    card.hidden = true;
    els.grid.textContent = "";
    els.count.textContent = "";
  }

  // ---------- Hook into the existing profile card ----------

  var origRender = AP.render;
  var origClear = AP.clear;
  AP.render = function (client, user) {
    origRender.apply(AP, arguments);
    start(client, user);
  };
  AP.clear = function () {
    origClear.apply(AP, arguments);
    clear();
  };
})();