// Lights Out: tabs for the Admin page.
// Layout only. This script regroups the existing admin sections into tabs at runtime (by their ids and headings), so
// admin.js, admin-season.js, admin-changes.js, admin-penalties.js and admin-corrections.js keep working unchanged: the
// elements are moved, not copied, so their ids, buttons and event handlers stay as they are.
// If a section is missing, its tab is simply not shown. Anything this script does not recognise stays in the Results tab.
(function () {
  "use strict";

  var panel = document.getElementById("admin-panel");
  if (!panel) { return; }

  var TABS = [
    { key: "results", label: "Results" },
    { key: "changes", label: "Driver changes" },
    { key: "penalties", label: "Grid penalties" },
    { key: "corrections", label: "Corrections" },
    { key: "season", label: "Season results" },
    { key: "log", label: "Import log" }
  ];
  var SECTION_IDS = { "season-admin": "season", "changes-admin": "changes", "penalties-admin": "penalties", "corrections-admin": "corrections" };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  // 1. Decide which tab each existing element belongs to.
  var groups = {};
  TABS.forEach(function (t) { groups[t.key] = []; });
  var current = null;
  var firstMoved = null;

  Array.prototype.slice.call(panel.children).forEach(function (node) {
    var key = SECTION_IDS[node.id] || null;
    if (!key && node.matches && node.matches("h2.admin-section-title")) {
      var text = node.textContent.trim().toLowerCase();
      if (/pending|missing|recent/.test(text)) { key = "results"; }
      else if (/import log/.test(text)) { key = "log"; }
    }
    if (key) { current = key; }
    if (current) {
      if (!firstMoved) { firstMoved = node; }
      groups[current].push(node);
    }
  });

  if (!firstMoved) { return; }

  // 2. Build the tab bar and one panel per tab, then move the elements into them.
  var bar = el("div", "at-tabs");
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Admin sections");
  var panes = {};
  var buttons = {};

  TABS.forEach(function (t) {
    if (groups[t.key].length === 0) { return; }
    var btn = el("button", "at-tab", t.label);
    btn.type = "button";
    btn.id = "at-tab-" + t.key;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", "at-pane-" + t.key);
    btn.setAttribute("data-key", t.key);
    bar.appendChild(btn);
    buttons[t.key] = btn;

    var pane = el("div", "at-pane");
    pane.id = "at-pane-" + t.key;
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", btn.id);
    pane.hidden = true;
    panes[t.key] = pane;
  });

  panel.insertBefore(bar, firstMoved);
  var after = bar;
  TABS.forEach(function (t) {
    if (!panes[t.key]) { return; }
    groups[t.key].forEach(function (node) { panes[t.key].appendChild(node); });
    after.parentNode.insertBefore(panes[t.key], after.nextSibling);
    after = panes[t.key];
  });

  // 3. Switching.
  var active = null;

  function show(key, focus) {
    if (!panes[key]) { key = "results"; }
    active = key;
    Object.keys(panes).forEach(function (k) {
      var on = k === key;
      panes[k].hidden = !on;
      buttons[k].setAttribute("aria-selected", on ? "true" : "false");
      buttons[k].tabIndex = on ? 0 : -1;
    });
    if (focus) { buttons[key].focus(); }
  }

  bar.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest(".at-tab") : null;
    if (!b) { return; }
    var key = b.getAttribute("data-key");
    show(key, false);
    try { history.replaceState(null, "", "#" + key); } catch (err) { /* ignore */ }
  });

  bar.addEventListener("keydown", function (e) {
    var keys = Object.keys(buttons);
    var i = keys.indexOf(active);
    if (e.key === "ArrowRight") { show(keys[(i + 1) % keys.length], true); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { show(keys[(i + keys.length - 1) % keys.length], true); e.preventDefault(); }
    else if (e.key === "Home") { show(keys[0], true); e.preventDefault(); }
    else if (e.key === "End") { show(keys[keys.length - 1], true); e.preventDefault(); }
  });

  window.addEventListener("hashchange", function () { show(window.location.hash.replace("#", ""), false); });

  show(window.location.hash.replace("#", "") || "results", false);

  // 4. A count on the Results tab while results are waiting for approval (read from the list admin.js fills in).
  var pending = document.getElementById("pending-list");
  if (pending && buttons.results) {
    var badge = el("span", "at-badge");
    badge.hidden = true;
    buttons.results.appendChild(badge);
    var update = function () {
      var n = pending.children.length;
      badge.textContent = String(n);
      badge.hidden = n === 0;
      buttons.results.setAttribute("aria-label", n > 0 ? "Results, " + n + " waiting for approval" : "Results");
    };
    new MutationObserver(update).observe(pending, { childList: true });
    update();
  }
})();
