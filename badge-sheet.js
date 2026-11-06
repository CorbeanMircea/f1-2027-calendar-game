// Lights Out: badge sheet. Shows every achievement badge at every step, locked and unlocked.
// A design review page: no database, no sign-in. Needs lo-achievements.js.
(function () {
  "use strict";

  var A = window.LO_ACH;
  var host = document.getElementById("sheet");
  if (!A || !host) { return; }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function tile(def, step, usedSteps) {
    var locked = step === 0;
    var fig = el("figure", "bs-tile" + (!locked && usedSteps.indexOf(step) === -1 ? " is-unused" : ""));
    var art = el("div", "bs-art");
    art.innerHTML = A.badgeSvg(def.key, locked ? 1 : step, locked, 112);
    fig.appendChild(art);
    var label = locked ? "Locked" : "Step " + A.STEP_LABEL[step - 1];
    if (!locked && usedSteps.indexOf(step) === -1) { label += " \u00b7 unused"; }
    fig.appendChild(el("figcaption", "", label));
    return fig;
  }

  A.DEFS.forEach(function (def) {
    var usedSteps = def.tiers.map(function (t) { return t[1]; });
    var row = el("section", "bs-row");
    row.setAttribute("aria-label", def.name);

    var head = el("div", "bs-head");
    head.appendChild(el("h2", "", def.name));
    head.appendChild(el("p", "", def.text));
    head.appendChild(el("p", "bs-levels", def.tiers.map(function (t) {
      return t[0].toLocaleString("en-GB") + " " + def.unit + " = step " + A.STEP_LABEL[t[1] - 1];
    }).join("  \u00b7  ")));
    row.appendChild(head);

    var tiles = el("div", "bs-tiles");
    [0, 1, 2, 3, 4].forEach(function (step) { tiles.appendChild(tile(def, step, usedSteps)); });
    row.appendChild(tiles);
    host.appendChild(row);
  });
})();