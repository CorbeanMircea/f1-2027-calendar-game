// Lights Out: session tabs for the predictions page.
// predict-tiles.js still owns the session <select>. This script only mirrors it as tabs:
// choosing a tab sets the select and fires its normal "change" event.
(function () {
  "use strict";

  var select = document.getElementById("session-select");
  var area = document.getElementById("form-area");
  var context = document.getElementById("pg-context");
  if (!select || !area) { return; }

  var tabsEl = document.createElement("div");
  tabsEl.className = "sess-tabs";
  tabsEl.setAttribute("role", "tablist");
  tabsEl.setAttribute("aria-label", "Session");
  var ctxEl = document.createElement("p");
  ctxEl.className = "sess-ctx";
  area.insertBefore(tabsEl, area.firstChild);
  area.insertBefore(ctxEl, tabsEl);

  function split(text) {
    var i = text.lastIndexOf(" - ");
    return i < 0 ? { event: "", type: text } : { event: text.slice(0, i), type: text.slice(i + 3) };
  }

  function build() {
    var opts = select.options;
    tabsEl.textContent = "";
    if (opts.length === 0) { area.classList.remove("has-tabs"); ctxEl.textContent = ""; return; }

    var events = {};
    var parts = [];
    for (var i = 0; i < opts.length; i++) {
      var p = split(opts[i].textContent);
      parts.push(p);
      events[p.event] = true;
    }
    var single = Object.keys(events).length === 1;
    ctxEl.textContent = single ? parts[0].event : "";
    if (context) { context.textContent = single ? parts[0].event : ""; }

    for (var j = 0; j < opts.length; j++) {
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "sess-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-id", opts[j].value);
      if (!single) {
        var ev = document.createElement("span");
        ev.className = "tab-ev";
        ev.textContent = parts[j].event;
        tab.appendChild(ev);
      }
      var ty = document.createElement("span");
      ty.className = "tab-ty";
      ty.textContent = parts[j].type;
      tab.appendChild(ty);
      tabsEl.appendChild(tab);
    }
    area.classList.add("has-tabs");
    sync();
  }

  function sync() {
    var tabs = tabsEl.children;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute("aria-selected", tabs[i].getAttribute("data-id") === select.value ? "true" : "false");
    }
  }

  tabsEl.addEventListener("click", function (e) {
    var tab = e.target.closest ? e.target.closest(".sess-tab") : null;
    if (!tab || tab.getAttribute("data-id") === select.value) { return; }
    select.value = tab.getAttribute("data-id");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
  });

  tabsEl.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") { return; }
    var tabs = Array.prototype.slice.call(tabsEl.children);
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) { return; }
    var next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
    e.preventDefault();
  });

  select.addEventListener("change", sync);
  new MutationObserver(build).observe(select, { childList: true });
  build();
})();
