// Lights Out: the page a password reset email leads to.
// It works on any device, whether or not you are signed in there: the link itself carries the
// permission to change the password. It supports every link style Supabase can send.
(function () {
  "use strict";

  // Read the link BEFORE the Supabase library tidies the address bar.
  var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  var queryParams = new URLSearchParams(window.location.search);
  function param(name) { return hashParams.get(name) || queryParams.get(name); }

  var cfg = window.APP_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var panels = { checking: $("checking"), form: $("form-panel"), done: $("done-panel"), expired: $("expired-panel") };
  var msg = $("msg");

  function show(name) {
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
  }

  function setMsg(kind, text) {
    msg.className = "message" + (kind ? " " + kind : "");
    msg.textContent = text || "";
  }

  function expired(text) {
    if (text) { $("expired-text").textContent = text; }
    show("expired");
  }

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    expired("The site configuration is incomplete.");
    return;
  }

  var linkError = param("error_description") || param("error_code") || param("error");
  if (linkError) {
    expired("The link has expired or was already used. Reset links only work once, and only for a short time.");
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  var ready = false;

  function showForm() {
    if (ready) { return; }
    ready = true;
    show("form");
    $("pw1").focus();
  }

  function tidyAddress() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }

  // The library normally turns the link into a session by itself and tells us with an event.
  client.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY") { showForm(); }
  });

  // If it did not, do it ourselves from whatever the link holds.
  function establish() {
    var access = param("access_token");
    var refresh = param("refresh_token");
    var code = queryParams.get("code");
    var tokenHash = param("token_hash");

    if (access && refresh) {
      return client.auth.setSession({ access_token: access, refresh_token: refresh })
        .then(function (r) { return !r.error && !!r.data.session; });
    }
    if (tokenHash && param("type") === "recovery") {
      return client.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" })
        .then(function (r) { return !r.error && !!r.data.session; });
    }
    if (code) {
      return client.auth.exchangeCodeForSession(code)
        .then(function (r) { return !r.error && !!r.data.session; });
    }
    return Promise.resolve(false);
  }

  window.setTimeout(function () {
    if (ready) { return; }
    establish().then(function (ok) {
      if (ready) { return; }
      if (ok) { showForm(); return; }
      // No usable link. If you are simply signed in, point to the normal place.
      client.auth.getSession().then(function (r) {
        if (ready) { return; }
        if (r.data && r.data.session && !param("type")) {
          expired("To change your password while signed in, use Change password on your Account page.");
          $("expired-panel").querySelector("a").textContent = "Go to my account";
        } else {
          expired();
        }
      });
    }).catch(function () { if (!ready) { expired(); } });
  }, 1200);

  $("reset-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var a = $("pw1").value;
    var b = $("pw2").value;
    if (a.length < 8) { setMsg("error", "The new password must have at least 8 characters."); return; }
    if (a !== b) { setMsg("error", "The two passwords do not match."); return; }
    $("save-button").disabled = true;
    setMsg("", "Saving...");
    client.auth.updateUser({ password: a }).then(function (r) {
      $("save-button").disabled = false;
      if (r.error) {
        console.error(r.error);
        setMsg("error", r.error.message || "Could not change the password.");
        return;
      }
      setMsg("", "");
      tidyAddress();
      show("done");

      // A reset ends with signing in again: sign out here, then go to the sign-in page.
      var email = r.data && r.data.user && r.data.user.email ? r.data.user.email : "";
      try { window.sessionStorage.setItem("lo-reset-email", email); } catch (e) { /* ignore */ }
      var pause = new Promise(function (resolve) { window.setTimeout(resolve, 1800); });
      Promise.all([client.auth.signOut(), pause]).then(function (results) {
        if (results[0] && results[0].error) { throw results[0].error; }
        window.location.href = "account.html?reset=done";
      }).catch(function (err) {
        console.error(err);
        $("done-text").textContent = "Your new password is saved, but this device could not be signed out automatically. Open your account and use Sign out, then sign in with the new password.";
        $("done-link").textContent = "Go to my account";
      });
    }).catch(function (err) {
      $("save-button").disabled = false;
      console.error(err);
      setMsg("error", "Something went wrong. Please try again.");
    });
  });
})();
