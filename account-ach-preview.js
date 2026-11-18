// Lights Out: achievement preview and filter on the Account page (redesign phase A3).
// Hover (mouse), focus (keyboard) or tap (phone) on an achievement shows what it is, how far you are and what you need to
// reach the next level. The numbers come from the database view that draws the cards (progress, level, next target); the
// rule text and the level table come from lo-achievements.js, and the level table is only shown when it matches the database.
// Also adds the All / Earned / Locked filter above the grid. It changes nothing in the data and nothing in the scoring.
(function () {
  "use strict";

  var A = window.LO_ACH;
  var grid = document.getElementById("ach-grid");
  var card = document.getElementById("ach-card");
  if (!A || !grid || !card) { return; }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function fmt(n) { return Number(n).toLocaleString("en-GB"); }

  var pop = el("div", "ach-pop");
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  document.body.appendChild(pop);

  var current = null;
  var hideTimer = null;
  var lastPointer = "mouse";

  // ----- the content -----
  function fill(li) {
    var def = A.BY_KEY[li.getAttribute("data-key")];
    if (!def) { return false; }
    var level = Number(li.getAttribute("data-level"));
    var max = Number(li.getAttribute("data-max"));
    var progress = Number(li.getAttribute("data-progress"));
    var nextRaw = li.getAttribute("data-next");
    var maxed = nextRaw === "";
    var next = maxed ? null : Number(nextRaw);
    var earned = li.getAttribute("data-earned");
    var locked = level === 0;

    pop.textContent = "";
    pop.setAttribute("aria-label", def.name);

    var head = el("div", "ap-head");
    head.appendChild(el("h4", "ap-title", def.name));
    head.appendChild(el("span", "ap-state", locked ? "Locked" : "Level " + level + " of " + max));
    pop.appendChild(head);
    pop.appendChild(el("p", "ap-rule", def.text));

    var pct = maxed ? 100 : Math.max(0, Math.min(100, Math.round((100 * progress) / next)));
    var bar = el("div", "ach-bar");
    var fill = el("span", "ach-fill");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    pop.appendChild(bar);

    if (maxed) {
      pop.appendChild(el("p", "ap-next", "Maximum level reached: " + fmt(progress) + " " + def.unit + "."));
    } else {
      var left = Math.max(0, next - progress);
      pop.appendChild(el("p", "ap-next",
        (locked ? "To unlock: " : "Next, level " + (level + 1) + ": ") + fmt(next) + " " + def.unit +
        ". You have " + fmt(progress) + (left > 0 ? ", " + fmt(left) + " to go." : ".")));
    }

    // The level table only when it matches the database (same number of levels and the same next target).
    var consistent = def.tiers.length === max && (maxed || (def.tiers[level] && def.tiers[level][0] === next));
    if (consistent) {
      var list = el("ol", "ap-levels");
      def.tiers.forEach(function (t, i) {
        var done = level >= i + 1;
        var li2 = el("li", done ? "is-done" : (i === level ? "is-next" : ""));
        li2.appendChild(el("span", "", "Level " + (i + 1)));
        li2.appendChild(el("span", "", fmt(t[0]) + " " + def.unit));
        list.appendChild(li2);
      });
      pop.appendChild(list);
    }

    if (earned) { pop.appendChild(el("p", "ap-earned", "Level " + level + " reached in " + earned)); }

    var close = el("button", "btn btn-small ap-close", "Close");
    close.type = "button";
    close.addEventListener("click", hide);
    pop.appendChild(close);
    return true;
  }

  // ----- placement -----
  function place(li) {
    var narrow = window.matchMedia("(max-width: 700px)").matches;
    pop.classList.toggle("is-sheet", narrow);
    pop.style.left = "";
    pop.style.top = "";
    if (narrow) { return; }
    var r = li.getBoundingClientRect();
    pop.style.visibility = "hidden";
    pop.hidden = false;
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = r.right + 12;
    var top = r.top + (r.height - h) / 2;
    if (left + w > vw - 12) { left = r.left - w - 12; }
    if (left < 12) {
      // no room at either side: above or below the card
      left = Math.max(12, Math.min(vw - w - 12, r.left + (r.width - w) / 2));
      top = r.bottom + 8;
      if (top + h > vh - 12) { top = r.top - h - 8; }
    }
    top = Math.max(12, Math.min(vh - h - 12, top));
    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
    pop.style.visibility = "";
  }

  function show(li) {
    window.clearTimeout(hideTimer);
    if (current === li && !pop.hidden) { return; }
    if (!fill(li)) { return; }
    current = li;
    place(li);
    pop.hidden = false;
  }

  function hide() {
    window.clearTimeout(hideTimer);
    pop.hidden = true;
    current = null;
  }

  function hideSoon() {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 120);
  }

  function cardOf(node) {
    return node && node.closest ? node.closest(".ach-card") : null;
  }

  // ----- events -----
  grid.addEventListener("pointerdown", function (e) { lastPointer = e.pointerType || "mouse"; });

  grid.addEventListener("pointerover", function (e) {
    if (e.pointerType !== "mouse") { return; }
    var li = cardOf(e.target);
    if (li) { show(li); }
  });

  grid.addEventListener("pointerout", function (e) {
    if (e.pointerType !== "mouse") { return; }
    var to = e.relatedTarget;
    if (to && (pop.contains(to) || cardOf(to) === current)) { return; }
    hideSoon();
  });

  pop.addEventListener("pointerenter", function () { window.clearTimeout(hideTimer); });
  pop.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") { hideSoon(); } });

  // touch and pen: tap to open, tap again to close
  grid.addEventListener("click", function (e) {
    if (lastPointer === "mouse") { return; }
    var li = cardOf(e.target);
    if (!li) { return; }
    if (current === li && !pop.hidden) { hide(); } else { show(li); }
  });

  // keyboard
  // Focus from the keyboard shows the preview. A tap or a click also focuses the card, but that must not open it
  // (the tap handler does), so only :focus-visible counts.
  grid.addEventListener("focusin", function (e) {
    var li = cardOf(e.target);
    if (!li) { return; }
    var viaKeyboard = true;
    try { viaKeyboard = li.matches(":focus-visible"); } catch (err) { viaKeyboard = true; }
    if (viaKeyboard) { show(li); }
  });
  grid.addEventListener("focusout", function () { hideSoon(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { hide(); } });

  // anywhere else closes it
  document.addEventListener("pointerdown", function (e) {
    if (pop.hidden) { return; }
    if (pop.contains(e.target) || cardOf(e.target)) { return; }
    hide();
  });
  window.addEventListener("scroll", function () { if (!pop.hidden && !pop.classList.contains("is-sheet")) { hide(); } }, true);
  window.addEventListener("resize", hide);
  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest(".ac-tab")) { hide(); }
  });

  // ----- filter: All / Earned / Locked -----
  var bar = el("div", "ach-filters");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Show achievements");
  var empty = el("p", "ach-filter-empty", "Nothing here yet.");
  empty.hidden = true;
  var buttons = {};

  function applyFilter(key) {
    grid.setAttribute("data-filter", key);
    Object.keys(buttons).forEach(function (k) { buttons[k].setAttribute("aria-pressed", k === key ? "true" : "false"); });
    hide();
    var visible = 0;
    Array.prototype.forEach.call(grid.querySelectorAll(".ach-card"), function (li) {
      var locked = li.classList.contains("is-locked");
      if (key === "all" || (key === "earned" && !locked) || (key === "locked" && locked)) { visible++; }
    });
    empty.hidden = visible > 0 || grid.querySelectorAll(".ach-card").length === 0;
  }

  [["all", "All"], ["earned", "Earned"], ["locked", "Locked"]].forEach(function (pair) {
    var b = el("button", "ach-filter", pair[1]);
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", function () { applyFilter(pair[0]); });
    buttons[pair[0]] = b;
    bar.appendChild(b);
  });
  grid.parentNode.insertBefore(bar, grid);
  grid.parentNode.insertBefore(empty, grid.nextSibling);
  applyFilter("all");

  // cards are drawn again after a refresh: keep the chosen filter and the empty note in step
  new MutationObserver(function () { applyFilter(grid.getAttribute("data-filter") || "all"); }).observe(grid, { childList: true });
})();
