// Lights Out: unread-notification badge on the "Predictions" link of the shared navigation (Milestone M5b).
// Loaded by site-nav.js on every page. It reads only the signed-in player's own unread count (player_notifications, own rows
// only), through the same session the page already uses. It creates no second sign-in client, shows nothing when the player is
// signed out, and does nothing at all on a page without the site configuration. It never changes anything.
(function () {
  "use strict";

  var tries = 0;
  var base = "";
  var apikey = "";

  var STYLE =
    ".lo-badge{display:inline-flex;align-items:center;justify-content:center;min-width:1.2em;height:1.2em;padding:0 .35em;" +
    "margin-left:.45em;border-radius:999px;background:#ffd700;color:#111;font:700 .7rem/1 inherit;letter-spacing:0}" +
    ".lo-bottom a{position:relative}" +
    ".lo-bottom .lo-badge{position:absolute;top:.2rem;left:calc(50% + .55rem);margin:0}";

  function addStyle() {
    if (document.getElementById("lo-badge-style")) { return; }
    var style = document.createElement("style");
    style.id = "lo-badge-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // The access token the page's own sign-in already stored. Expired or missing: show nothing.
  function accessToken() {
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var key = window.localStorage.key(i);
        if (key && /^sb-.*-auth-token$/.test(key)) {
          var session = JSON.parse(window.localStorage.getItem(key));
          if (session && session.access_token && (!session.expires_at || session.expires_at * 1000 > Date.now())) {
            return session.access_token;
          }
        }
      }
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function setBadge(count) {
    var links = document.querySelectorAll('.lo-nav a[href="predict.html"], .lo-bottom a[href="predict.html"]');
    Array.prototype.forEach.call(links, function (a) {
      var badge = a.querySelector(".lo-badge");
      if (!count) {
        if (badge) { a.removeChild(badge); }
        return;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "lo-badge";
        a.appendChild(badge);
      }
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.setAttribute("aria-label", count + (count === 1 ? " new notification" : " new notifications"));
    });
  }

  function refresh() {
    var token = accessToken();
    if (!token) { setBadge(0); return; }
    window.fetch(base + "/rest/v1/player_notifications?select=id&read_at=is.null&limit=50", {
      headers: { apikey: apikey, authorization: "Bearer " + token }
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (rows) {
      if (Array.isArray(rows)) { setBadge(rows.length); }
    }).catch(function () { /* the badge is optional */ });
  }

  function start() {
    var cfg = window.APP_CONFIG;
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY || String(cfg.SUPABASE_PUBLISHABLE_KEY).indexOf("PASTE_") === 0) {
      // config.js is loaded at the end of the page: wait for it (up to about 10 seconds), then give up quietly.
      if (++tries < 40) { window.setTimeout(start, 250); }
      return;
    }
    base = String(cfg.SUPABASE_URL).replace(/\/+$/, "");
    apikey = cfg.SUPABASE_PUBLISHABLE_KEY;
    addStyle();
    refresh();
    window.addEventListener("lo-notices-changed", refresh);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { refresh(); }
    });
    window.setInterval(refresh, 300000);
  }

  start();
})();
