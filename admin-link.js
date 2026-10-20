(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var link = document.getElementById("admin-link");
  if (!link || !window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  // The link only appears for administrators. The admin page and the server check this again.
  client.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (!session) { return; }
    return client.rpc("is_admin").then(function (adminResult) {
      if (adminResult.error || adminResult.data !== true) { return; }
      link.hidden = false;
      return client.rpc("admin_pending_count").then(function (countResult) {
        if (!countResult.error && countResult.data > 0) {
          link.textContent = "Admin (" + countResult.data + " pending)";
        }
      });
    });
  }).catch(function (err) {
    console.error(err);
  });
})();