// Lights Out: welcome flow for new players.
//   Home page:    a "Getting started" card for signed-in players, with the steps that make the game work (join the league,
//                 design a helmet, learn the rules, turn on reminders, pick the champions, make a first prediction).
//                 It ticks the steps off by itself and disappears when everything is done (or for two weeks when the player hides it).
//   Account page: an invite link, account.html?invite=CODE, fills in the invite code for the player (and remembers it
//                 through sign-up and e-mail confirmation).
// It adds to the pages and changes nothing else: no database change, and the other scripts are untouched.
(function () {
  "use strict";

  var INVITE_KEY = "lo-invite";
  var RULES_KEY = "lo-rules-seen";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function store(key, value) {
    try { if (value === null) { localStorage.removeItem(key); } else { localStorage.setItem(key, value); } } catch (e) { /* ignore */ }
  }

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  // ---------- invite link: ?invite=CODE ----------

  var wanted = null;
  try { wanted = new URLSearchParams(window.location.search).get("invite"); } catch (e) { /* ignore */ }
  if (wanted) {
    wanted = wanted.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (wanted.length >= 3) { store(INVITE_KEY, wanted); }
  }

  var codeInput = document.getElementById("join-code");
  if (codeInput) {
    var saved = read(INVITE_KEY);
    if (saved && !codeInput.value) { codeInput.value = saved; }

    var form = document.getElementById("auth-form");
    if (saved && form && form.parentNode) {
      var note = el("p", "wl-invite", "You have been invited to the league. Create an account (or sign in): your invite code will be filled in for you.");
      form.parentNode.insertBefore(note, form);
    }
  }

  // ---------- the Getting started card (Home page) ----------

  var anchor = document.getElementById("recap");
  var cfg = window.APP_CONFIG || {};
  if (!anchor || !window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_PUBLISHABLE_KEY.indexOf("PASTE_") === 0) {
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);

  function count(query) {
    return query.then(function (res) { return res.error ? null : (res.data || []); }, function () { return null; });
  }

  client.auth.getSession().then(function (r) {
    var session = r.data && r.data.session;
    if (!session) { return; }
    var uid = session.user.id;
    var hiddenKey = "lo-welcome-hidden-" + uid;
    // "Hide" keeps the card away for two weeks; after that it comes back if something new needs doing (for example the
    // season picks of a new season).
    var hiddenAt = Number(read(hiddenKey));
    if (hiddenAt && Date.now() - hiddenAt < 14 * 24 * 3600 * 1000) { return; }

    return Promise.all([
      count(client.from("group_members").select("user_id").eq("user_id", uid).limit(1)),
      count(client.from("profiles").select("avatar").eq("id", uid).limit(1)),
      count(client.from("push_subscriptions").select("endpoint").eq("user_id", uid).limit(1)),
      count(client.from("predictions").select("session_id").eq("user_id", uid).limit(1)),
      count(client.from("season_prediction_windows").select("season, is_open, late_open")),
      count(client.from("season_predictions").select("season").eq("user_id", uid))
    ]).then(function (res) {
      var member = res[0] === null ? null : res[0].length > 0;
      var avatar = res[1] === null ? null : !!(res[1][0] && res[1][0].avatar);
      var push = res[2] === null ? null : res[2].length > 0;
      var predicted = res[3] === null ? null : res[3].length > 0;
      var windows = (res[4] || []).filter(function (w) { return w.season < 9000 && (w.is_open || w.late_open); })
        .sort(function (a, b) { return a.season - b.season; });
      var picked = res[5] || [];

      if (member) { store(INVITE_KEY, null); }

      var steps = [];
      if (member !== null) {
        steps.push({ title: "Join the league", hint: "Enter the invite code you were given.", href: "account.html#settings", cta: "Join", done: member });
      }
      if (avatar !== null) {
        steps.push({ title: "Design your helmet", hint: "Pick a pattern and colours: it shows next to your name.", href: "account.html", cta: "Open", done: avatar });
      }
      steps.push({ title: "Learn how scoring works", hint: "A two-minute read: deadlines, points and season picks.", href: "how-to-play.html", cta: "Read",
        done: read(RULES_KEY) === "1", mark: RULES_KEY });
      if (push !== null) {
        steps.push({ title: "Turn on reminders", hint: "On an iPhone, install the app to your home screen first.", href: "account.html#settings", cta: "Turn on", done: push });
      }
      if (windows.length > 0) {
        var open = windows[0].season;
        steps.push({ title: "Pick your champions", hint: "Drivers' and Constructors' champion for " + open + ". The picks close at the first race weekend.",
          href: "predict.html", cta: "Pick",
          done: picked.some(function (p) { return p.season === open; }) });
      }
      if (predicted !== null) {
        steps.push({ title: "Make your first prediction", hint: "Qualifying and Race are open before every Grand Prix.", href: "predict.html", cta: "Predict", done: predicted });
      }

      var left = steps.filter(function (s) { return !s.done; });
      if (left.length === 0) { return; }

      render(steps, left.length, hiddenKey);
    });
  }).catch(function () { /* the card is optional: never get in the way of the page */ });

  function render(steps, left, hiddenKey) {
    var done = steps.length - left;
    var card = el("section", "wl");
    card.id = "welcome";
    card.setAttribute("aria-label", "Getting started");

    var head = el("div", "wl-head");
    var titles = el("div");
    titles.appendChild(el("p", "wl-eyebrow", "Getting started"));
    titles.appendChild(el("h2", "wl-title", done === 0 ? "Welcome to Lights Out" : done + " of " + steps.length + " done"));
    head.appendChild(titles);

    var lights = el("div", "wl-lights");
    lights.setAttribute("aria-hidden", "true");
    steps.forEach(function (s) { lights.appendChild(el("span", "wl-light" + (s.done ? " on" : ""))); });
    head.appendChild(lights);

    var hide = el("button", "wl-hide", "Hide");
    hide.type = "button";
    hide.addEventListener("click", function () { store(hiddenKey, String(Date.now())); card.remove(); });
    head.appendChild(hide);
    card.appendChild(head);

    var list = el("ol", "wl-steps");
    var shownNext = false;
    steps.forEach(function (s) {
      var li = el("li", "wl-step" + (s.done ? " done" : ""));
      var mark = el("span", "wl-mark", s.done ? "\u2713" : "");
      mark.setAttribute("aria-hidden", "true");
      li.appendChild(mark);

      var text = el("div", "wl-text");
      text.appendChild(el("b", "", s.title));
      text.appendChild(el("span", "wl-hint", s.done ? "Done" : s.hint));
      li.appendChild(text);

      if (!s.done) {
        var a = el("a", "wl-go" + (shownNext ? "" : " primary"), s.cta);
        a.href = s.href;
        if (s.mark) { a.addEventListener("click", function () { store(s.mark, "1"); }); }
        li.appendChild(a);
        shownNext = true;
      }
      list.appendChild(li);
    });
    card.appendChild(list);

    anchor.parentNode.insertBefore(card, anchor);
  }
})();
