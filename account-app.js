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
