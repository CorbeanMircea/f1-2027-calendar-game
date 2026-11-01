// Lights Out: the "Get the app and reminders" panel on the Account page.
// Install button (or the right instructions for this device) and the calendar subscription links.
(function () {
  "use strict";

  var panel = document.getElementById("app-panel");
  if (!panel) { return; }

  var cfg = window.APP_CONFIG || {};
  var installBtn = document.getElementById("install-button");
  var installNote = document.getElementById("install-note");
  var calUrl = document.getElementById("cal-url");
  var calApple = document.getElementById("cal-apple");
  var calGoogle = document.getElementById("cal-google");
  var calCopy = document.getElementById("cal-copy");

  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  }

  function isIOS() {
    var ua = window.navigator.userAgent || "";
    return /iphone|ipad|ipod/i.test(ua) || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
  }

  function updateInstall() {
    var pwa = window.LO_PWA || {};
    installBtn.hidden = true;
    if (isStandalone()) {
      installNote.textContent = "Lights Out is installed on this device. You are using the app.";
    } else if (pwa.prompt) {
      installNote.textContent = "Add Lights Out to your home screen to open it like an app, full screen and with its own icon.";
      installBtn.hidden = false;
    } else if (isIOS()) {
      installNote.textContent = "On iPhone and iPad: open this page in Safari, tap the Share button, then choose Add to Home Screen.";
    } else {
      installNote.textContent = "Open this site in Chrome or Edge and choose Install app from the browser menu to add it to your device.";
    }
  }

  installBtn.addEventListener("click", function () {
    var pwa = window.LO_PWA;
    if (!pwa || !pwa.prompt) { return; }
    pwa.prompt.prompt();
    pwa.prompt.userChoice.then(function () {
      pwa.prompt = null;
      updateInstall();
    });
  });

  window.addEventListener("lo-install-ready", updateInstall);
  window.addEventListener("lo-installed", updateInstall);
  updateInstall();

  // ---------- Push reminders ----------

  var pushBlock = document.getElementById("push-block");
  var pushNote = document.getElementById("push-note");
  var pushOn = document.getElementById("push-on");
  var pushOff = document.getElementById("push-off");
  var pushTest = document.getElementById("push-test");
  var vapid = cfg.VAPID_PUBLIC_KEY;

  function pushSupported() {
    return "serviceWorker" in window.navigator && "PushManager" in window && "Notification" in window;
  }

  function keyBytes(text) {
    var pad = new Array(((4 - (text.length % 4)) % 4) + 1).join("=");
    var raw = window.atob((text + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) { out[i] = raw.charCodeAt(i); }
    return out;
  }

  function currentSubscription() {
    return window.navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); });
  }

  function showButtons(on, off, test) {
    pushOn.hidden = !on;
    pushOff.hidden = !off;
    pushTest.hidden = !test;
  }

  function refreshPush() {
    if (!vapid) { pushBlock.hidden = true; return Promise.resolve(); }
    pushBlock.hidden = false;
    showButtons(false, false, false);

    if (!pushSupported()) {
      pushNote.textContent = isIOS() && !isStandalone()
        ? "On iPhone and iPad, reminders work in the installed app. Add Lights Out to your home screen (see above), open it from there, and come back to this page."
        : "This browser cannot show push reminders. The calendar reminders below work everywhere.";
      return Promise.resolve();
    }
    if (window.Notification.permission === "denied") {
      pushNote.textContent = "Notifications are blocked for this site. Allow them in your browser or phone settings, then reload this page.";
      return Promise.resolve();
    }
    return currentSubscription().then(function (sub) {
      if (sub && window.Notification.permission === "granted") {
        pushNote.textContent = "Reminders are on for this device. You get a message 3 hours and 1 hour before a deadline if you have not predicted yet.";
        showButtons(false, true, true);
      } else {
        pushNote.textContent = "Get a message on this device before a deadline if you have not predicted yet.";
        showButtons(true, false, false);
      }
    });
  }

  function signedInClient() {
    var c = window.LO_CLIENT;
    if (!c) { return Promise.resolve(null); }
    return c.auth.getSession().then(function (r) { return r.data && r.data.session ? { client: c, session: r.data.session } : null; });
  }

  pushOn.addEventListener("click", function () {
    pushOn.disabled = true;
    var stop = false; // true when a message was shown and the buttons should stay as they are

    signedInClient().then(function (ctx) {
      if (!ctx) {
        pushNote.textContent = "Sign in first, then turn on reminders.";
        stop = true;
        return null;
      }
      return window.Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") { return null; } // refreshPush explains a blocked setting
        return window.navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.getSubscription().then(function (existing) {
            return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapid) });
          });
        }).then(function (sub) {
          var j = sub.toJSON();
          return ctx.client.rpc("save_push_subscription", {
            p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: window.navigator.userAgent
          }).then(function (res) {
            if (!res.error) { return null; }
            console.error(res.error);
            stop = true;
            return sub.unsubscribe().then(function () {
              pushNote.textContent = /Join the friends group/i.test(res.error.message || "")
                ? "Join the friends group first, then turn on reminders."
                : "Could not save this device. Reminders need the latest database update (021_push_reminders.sql).";
            });
          });
        });
      });
    }).catch(function (err) {
      console.error(err);
      stop = true;
      pushNote.textContent = "Could not turn on reminders on this device. Please try again.";
    }).then(function () {
      pushOn.disabled = false;
      return stop ? null : refreshPush();
    });
  });

  function removeThisDevice() {
    return currentSubscription().then(function (sub) {
      if (!sub) { return null; }
      var endpoint = sub.endpoint;
      return signedInClient().then(function (ctx) {
        return ctx ? ctx.client.rpc("remove_push_subscription", { p_endpoint: endpoint }) : null;
      }).then(function () { return sub.unsubscribe(); });
    });
  }

  pushOff.addEventListener("click", function () {
    pushOff.disabled = true;
    removeThisDevice().catch(function (err) { console.error(err); }).then(function () {
      pushOff.disabled = false;
      return refreshPush();
    });
  });

  // account.js calls this just before signing out, so reminders never go to the next person.
  window.LO_PUSH_CLEANUP = function () {
    if (!vapid || !pushSupported()) { return Promise.resolve(); }
    return removeThisDevice().catch(function () { /* ignore */ });
  };

  pushTest.addEventListener("click", function () {
    pushTest.disabled = true;
    signedInClient().then(function (ctx) {
      if (!ctx) { pushNote.textContent = "Sign in first."; return null; }
      var base = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
      return window.fetch(base + "/functions/v1/send-reminders?task=test", {
        headers: { authorization: "Bearer " + ctx.session.access_token, apikey: cfg.SUPABASE_PUBLISHABLE_KEY }
      }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
        .then(function (res) {
          pushNote.textContent = res.sent > 0
            ? "Test sent to " + res.sent + (res.sent === 1 ? " device" : " devices") + ". It should appear in a few seconds."
            : "No device received it. Turn reminders off and on again on this device.";
        });
    }).catch(function (err) {
      console.error(err);
      pushNote.textContent = "Could not send the test. Check that the send-reminders function is deployed.";
    }).then(function () { pushTest.disabled = false; });
  });

  refreshPush();

  // ---------- Calendar ----------

  var base = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    document.getElementById("app-panel").querySelectorAll("#cal-apple, #cal-google, #cal-copy, #cal-url").forEach(function (n) { n.hidden = true; });
    return;
  }

  var feed = base + "/functions/v1/calendar-feed";
  var webcal = feed.replace(/^https?:/, "webcal:");
  calUrl.value = feed;
  calApple.href = webcal;
  calGoogle.href = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal);

  calCopy.addEventListener("click", function () {
    var done = function () { calCopy.textContent = "Copied"; window.setTimeout(function () { calCopy.textContent = "Copy link"; }, 1800); };
    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      window.navigator.clipboard.writeText(feed).then(done, function () { calUrl.select(); });
    } else {
      calUrl.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* the link stays selected for manual copy */ }
    }
  });
})();
