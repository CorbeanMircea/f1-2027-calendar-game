// Lights Out: shared navigation. One source for the top bar and the mobile bottom bar.
// Add <script src="site-nav.js"></script> as the first thing inside <body> on every page,
// and link site-chrome.css in <head>. The script runs before the page is painted, so
// there is no flash. Nothing here reads user data; the markup is fixed.
(function () {
  "use strict";

  var PAGES = [
    { file: "index.html", label: "Home", short: "Home",
      icon: "M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10" },
    { file: "predict.html", label: "Predictions", short: "Predict",
      icon: "M4 21V4h13v6H8M4 14h9" },
    { file: "leaderboard.html", label: "Leaderboard", short: "Board",
      icon: "M3 21h18M5 21v-8h4v8M10 21V5h4v16M15 21v-5h4v5" },
    { file: "account.html", label: "Account", short: "Account",
      icon: "M5 21v-3a4 4 0 014-4h6a4 4 0 014 4v3M9 8a3 3 0 106 0 3 3 0 00-6 0" }
  ];

  var current = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (current === "") { current = "index.html"; }

  function aria(file) { return current === file ? ' aria-current="page"' : ""; }

  var top = "";
  var bottom = "";
  PAGES.forEach(function (p) {
    top += '<a href="' + p.file + '"' + aria(p.file) + ">" + p.label + "</a>";
    bottom += '<a href="' + p.file + '"' + aria(p.file) + '>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + p.icon + '"/></svg>' +
      "<span>" + p.short + "</span></a>";
  });

  var html =
    '<header class="lo-header"><div class="lo-header-in">' +
      '<a class="lo-mark" href="index.html" aria-label="Lights Out, home">' +
        '<span class="lo-mark-lights" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' +
        "<span>Lights Out</span></a>" +
      '<nav class="lo-nav" aria-label="Main">' + top +
        '<a href="admin.html" id="admin-link"' + aria("admin.html") + " hidden>Admin</a></nav>" +
    "</div></header>" +
    '<nav class="lo-bottom" aria-label="Main">' + bottom + "</nav>";

  document.body.insertAdjacentHTML("afterbegin", html);
  document.body.classList.add("has-chrome");
})();
