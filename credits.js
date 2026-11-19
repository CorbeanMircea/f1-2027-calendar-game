// Lights Out: lists the driver photograph credits from portraits.js (written by tools/optimize-portraits.mjs).
(function () {
  "use strict";

  var host = document.getElementById("cr-portraits");
  var all = window.LO_PORTRAITS || {};
  var codes = Object.keys(all).sort();

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  if (codes.length === 0) {
    host.appendChild(el("p", "cr-note", "No driver photographs have been added yet."));
    return;
  }

  var table = el("table", "cr-table");
  var head = document.createElement("thead");
  var hr = document.createElement("tr");
  ["Driver", "Photographer", "Licence", "Source"].forEach(function (t) {
    var th = el("th", "", t);
    th.scope = "col";
    hr.appendChild(th);
  });
  head.appendChild(hr);
  table.appendChild(head);

  var body = document.createElement("tbody");
  codes.forEach(function (code) {
    var p = all[code];
    var tr = document.createElement("tr");
    var th = el("th", "", code.toUpperCase());
    th.scope = "row";
    tr.appendChild(th);
    tr.appendChild(el("td", "", p.author));
    tr.appendChild(el("td", "", p.licence));
    var td = document.createElement("td");
    if (/^https:\/\//.test(p.url)) {
      var a = el("a", "", "Wikimedia Commons");
      a.href = p.url;
      a.rel = "noopener";
      td.appendChild(a);
    }
    tr.appendChild(td);
    body.appendChild(tr);
  });
  table.appendChild(body);

  var wrap = el("div", "cr-scroll");
  wrap.appendChild(table);
  host.appendChild(wrap);
})();
