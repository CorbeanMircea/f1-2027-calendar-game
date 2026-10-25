(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var box = document.getElementById("deadline-lights");
  var select = document.getElementById("session-select");
  var stateEl = document.getElementById("dl-state");
  var timeEl = document.getElementById("dl-time");
  if (!box || !select || !stateEl || !timeEl) { return; }
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var lightEls = box.querySelectorAll(".dl-light");
  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  var win = null;        // { lockMs, isOpen } from the server's prediction_windows view
  var loadedFor = "";
  var token = 0;
  var lastLit = -1;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function setLights(count, sequence) {
    for (var i = 0; i < lightEls.length; i++) {
      lightEls[i].style.setProperty("--d", (sequence ? i * 90 : 0) + "ms");
      if (i < count) {
        lightEls[i].classList.add("is-lit");
      } else {
        lightEls[i].classList.remove("is-lit");
      }
    }
    lastLit = count;
  }

  function untilText(ms) {
    var minutes = Math.max(0, Math.floor(ms / 60000));
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    var mins = minutes % 60;
    if (days > 0) { return days + " d " + hours + " h"; }
    if (hours > 0) { return hours + " h " + mins + " min"; }
    return mins + " min";
  }

  function whenText(ms) {
    return new Date(ms).toLocaleString([], {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  // The text states the real status. The server's is_open flag is the authority;
  // the lights only show how close the deadline is.
  function describe(now) {
    if (!win) { return null; }
    if (win.lockMs === null) {
      return { kind: "tbc", text: "Lock time not confirmed", time: "", lit: 0 };
    }
    if (!win.isOpen) {
      return { kind: "locked", text: "Predictions locked", time: "Closed " + whenText(win.lockMs), lit: 0 };
    }
    var remaining = win.lockMs - now;
    if (remaining <= 0) {
      return { kind: "locked", text: "Locking now", time: "Checking with the server", lit: 0 };
    }
    var hours = remaining / 3600000;
    var lit = hours <= 1 ? 5 : hours <= 6 ? 4 : hours <= 24 ? 3 : hours <= 72 ? 2 : 1;
    return {
      kind: remaining < 86400000 ? "soon" : "open",
      text: remaining < 86400000 ? "Predictions lock soon" : "Predictions open",
      time: "Locks in " + untilText(remaining),
      lit: lit
    };
  }

  function render(animate) {
    var info = describe(Date.now());
    if (!info) { box.hidden = true; return; }
    box.hidden = false;
    box.setAttribute("data-state", info.kind);
    stateEl.textContent = info.text;
    timeEl.textContent = info.time;

    if (animate && !reducedMotion()) {
      setLights(0, false);
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { setLights(info.lit, true); });
      });
    } else if (info.lit !== lastLit) {
      setLights(info.lit, false);
    }
  }

  function load(animate) {
    var id = select.value;
    if (!id) {
      win = null;
      box.hidden = true;
      return;
    }
    var mine = ++token;
    client.from("prediction_windows").select("lock_at, is_open").eq("session_id", id).limit(1)
      .then(function (result) {
        if (mine !== token) { return; }
        if (result.error || !result.data || result.data.length === 0) {
          win = null;
          box.hidden = true;
          return;
        }
        var row = result.data[0];
        win = {
          lockMs: row.lock_at ? Date.parse(row.lock_at) : null,
          isOpen: row.is_open === true
        };
        loadedFor = id;
        render(animate);
      });
  }

  select.addEventListener("change", function () { load(true); });

  // The predictions page fills the session menu after it loads.
  new MutationObserver(function () {
    if (select.value && select.value !== loadedFor) { load(true); }
  }).observe(select, { childList: true });

  window.setInterval(function () { render(false); }, 30000);
  window.setInterval(function () { load(false); }, 60000);

  if (select.value) { load(true); }
})();