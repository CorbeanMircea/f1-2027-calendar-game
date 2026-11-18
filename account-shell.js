// Lights Out: Account page shell (redesign phase A1).
// Builds the section rail (desktop) / chips (phone) and switches between four sections of the page: Overview, Season stats,
// Achievements and Settings. It only shows and hides blocks that the existing scripts already fill; it never changes how
// sign-in, the group, the profile, the statistics, the achievements, the reminders or the install work.
// Sections have links: account.html#overview, #stats, #achievements and #settings. If this script fails, the page still works
// (every section stays visible one under the other, as before).
(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  var ac = byId("ac");
  var rail = byId("ac-rail");
  var signedOut = byId("signed-out-view");
  if (!ac || !rail || !signedOut) { return; }

  var join = byId("join-section");
  var statsBody = byId("stats-body");
  var achGrid = byId("ach-grid");
  var pushBlock = byId("push-block");
  var pushOn = byId("push-on");
  var installBtn = byId("install-button");
  var setup = byId("ac-setup");
  var todo = byId("ac-todo");
  var ovSeason = byId("ov-season");

  var VIEWS = [
    { key: "overview", label: "Overview" },
    { key: "stats", label: "Season stats" },
    { key: "achievements", label: "Achievements" },
    { key: "settings", label: "Settings" }
  ];

  var state = { view: "overview", chosen: false, auto: false };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function isIn() { return signedOut.hidden === true; }
  function needsJoin() { return !!join && join.hidden === false; }
  function isKey(k) { return VIEWS.some(function (v) { return v.key === k; }); }

  // Someone who has not joined the group yet has no statistics or achievements: only Overview and Settings are offered.
  function visibleViews() {
    return VIEWS.filter(function (v) { return !needsJoin() || v.key === "overview" || v.key === "settings"; });
  }

  function hashView() {
    var h = (window.location.hash || "").replace(/^#/, "");
    return isKey(h) ? h : null;
  }

  function applyView(key) {
    state.view = key;
    ac.setAttribute("data-view", key);
    renderRail();
  }

  // push = true for a click (the browser Back button then returns to the previous section)
  function setView(key, push) {
    if (!isKey(key)) { return; }
    state.chosen = true;
    state.auto = false;
    if (push && hashView() !== key) {
      try { window.history.pushState(null, "", "#" + key); } catch (e) { /* the section still changes */ }
    }
    applyView(key);
  }

  function newAchievements() {
    return achGrid ? achGrid.querySelectorAll(".ach-new").length : 0;
  }

  function badgeFor(key) {
    if (key === "achievements") {
      var n = newAchievements();
      return n > 0 ? n + " new" : "";
    }
    if (key === "settings" && needsJoin()) { return "Join"; }
    return "";
  }

  function renderRail() {
    rail.textContent = "";
    var list = el("ul", "ac-rail-list");
    visibleViews().forEach(function (v) {
      var li = document.createElement("li");
      var btn = el("button", "ac-tab");
      btn.type = "button";
      btn.setAttribute("aria-current", v.key === state.view ? "true" : "false");
      btn.appendChild(el("span", "ac-tab-name", v.label));
      var b = badgeFor(v.key);
      if (b) { btn.appendChild(el("span", "ac-badge", b)); }
      btn.addEventListener("click", function () { setView(v.key, true); });
      li.appendChild(btn);
      list.appendChild(li);
    });
    rail.appendChild(list);
  }

  // ----- the "Set up" card of the Overview: only what still needs doing -----
  function renderSetup() {
    if (!setup || !todo) { return; }
    var items = [];
    if (needsJoin()) {
      items.push({ text: "Join the friends group to start predicting.", go: "settings", label: "Join" });
    }
    if (pushBlock && pushBlock.hidden === false && pushOn && pushOn.hidden === false) {
      items.push({ text: "Turn on reminders so you never miss a deadline.", go: "settings", label: "Open settings" });
    }
    if (installBtn && installBtn.hidden === false) {
      items.push({ text: "Install Lights Out on your phone.", go: "settings", label: "Open settings" });
    }
    todo.textContent = "";
    items.forEach(function (it) {
      var li = el("li", "ac-todo-item");
      li.appendChild(el("span", "", it.text));
      var b = el("button", "link-btn", it.label);
      b.type = "button";
      b.setAttribute("data-go", it.go);
      li.appendChild(b);
      todo.appendChild(li);
    });
    setup.hidden = items.length === 0;
  }

  // ----- the "This season" card of the Overview mirrors the numbers of the Season stats section -----
  function copyText(from, to) {
    var a = byId(from);
    var b = byId(to);
    if (a && b) { b.textContent = a.textContent; }
  }

  function renderSeason() {
    if (!ovSeason) { return; }
    var show = !!statsBody && statsBody.hidden === false;
    ovSeason.hidden = !show;
    if (show) {
      copyText("st-points", "ov-points");
      copyText("st-rank", "ov-rank");
      copyText("st-acc", "ov-acc");
    }
  }

  // ----- keep everything in step with the page -----
  function sync() {
    ac.setAttribute("data-auth", isIn() ? "in" : "out");
    if (isIn() && needsJoin() && !state.chosen && !hashView()) {
      state.auto = true;
      state.view = "settings";
      ac.setAttribute("data-view", "settings");
    } else if (state.auto && !needsJoin()) {
      state.auto = false;
      state.view = "overview";
      ac.setAttribute("data-view", "overview");
    }
    if (!visibleViews().some(function (v) { return v.key === state.view; })) {
      state.view = "overview";
      ac.setAttribute("data-view", "overview");
    }
    renderRail();
    renderSetup();
    renderSeason();
    ac.classList.add("shell-ready");
  }

  function watch(node, options) {
    if (node) { new MutationObserver(sync).observe(node, options); }
  }

  watch(signedOut, { attributes: true, attributeFilter: ["hidden"] });
  watch(join, { attributes: true, attributeFilter: ["hidden"] });
  watch(pushBlock, { attributes: true, attributeFilter: ["hidden"] });
  watch(pushOn, { attributes: true, attributeFilter: ["hidden"] });
  watch(installBtn, { attributes: true, attributeFilter: ["hidden"] });
  watch(statsBody, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true, characterData: true });
  watch(achGrid, { childList: true, subtree: true });

  ac.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("[data-go]") : null;
    if (t && isKey(t.getAttribute("data-go"))) { setView(t.getAttribute("data-go"), true); }
  });

  window.addEventListener("popstate", function () {
    var k = hashView();
    state.auto = false;
    applyView(k || "overview");
  });

  var first = hashView();
  if (first) { state.chosen = true; state.view = first; ac.setAttribute("data-view", first); }
  sync();
})();
