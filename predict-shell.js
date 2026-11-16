// Lights Out: Predictions page shell (redesign phase 1).
// Builds the left rail (desktop) / context bar (phone) from the session menu that predict-tiles.js already fills, and makes
// Season picks a destination of its own. It never changes how predictions are loaded, validated, saved or scored:
// choosing a session sets the existing <select id="session-select"> and fires its normal "change" event, exactly like
// predict-ui.js does for the old tabs. If this script fails, the page keeps working with the old tabs.
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var pl = document.getElementById("pl");
  var rail = document.getElementById("pl-rail-in");
  var select = document.getElementById("session-select");
  var area = document.getElementById("form-area");
  var banner = document.getElementById("pl-banner");
  var bannerBtn = document.getElementById("pl-banner-go");
  var seasonCard = document.getElementById("season-card");
  var spState = document.getElementById("sp-state");
  var spSub = document.getElementById("sp-sub");
  var spBody = document.getElementById("sp-body");
  var pickStatus = document.getElementById("pick-status");
  if (!pl || !rail || !select || !area) { return; }

  var state = { windows: {}, saved: {}, view: "session" };
  var client = null;
  if (window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY &&
      String(cfg.SUPABASE_PUBLISHABLE_KEY).indexOf("PASTE_") !== 0) {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  }

  var head = document.createElement("div");
  head.className = "pl-head";
  var headEv = document.createElement("p");
  headEv.className = "pl-head-ev";
  var headTy = document.createElement("h2");
  headTy.className = "pl-head-ty";
  head.appendChild(headEv);
  head.appendChild(headTy);
  area.insertBefore(head, area.firstChild);

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function split(text) {
    var i = text.lastIndexOf(" - ");
    return i < 0 ? { event: "", type: text } : { event: text.slice(0, i), type: text.slice(i + 3) };
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

  function options() {
    var out = [];
    for (var i = 0; i < select.options.length; i++) {
      var p = split(select.options[i].textContent);
      out.push({ id: select.options[i].value, event: p.event, type: p.type });
    }
    return out;
  }

  function seasonInfo() {
    if (!seasonCard || seasonCard.hidden) { return null; }
    var kind = spState ? spState.getAttribute("data-kind") : "";
    var saved = !!(spBody && spBody.querySelector('.pick-status[data-kind="saved"]'));
    var label = "";
    var tone = "";
    if (kind === "open") { label = saved ? "Saved" : "To do"; tone = saved ? "is-saved" : "is-todo"; }
    else if (kind === "closed") { label = "Locked"; tone = ""; }
    else if (kind === "waiting") { label = "Opens soon"; tone = ""; }
    else { label = "Season"; tone = ""; }
    return { kind: kind, saved: saved, label: label, tone: tone, sub: spSub ? spSub.textContent : "" };
  }

  function setView(view) {
    state.view = view;
    pl.setAttribute("data-view", view);
    render();
  }

  function choose(id) {
    state.view = "session";
    pl.setAttribute("data-view", "session");
    if (select.value !== id) {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    render();
  }

  function chip(text, tone) {
    return el("span", "pl-chip" + (tone ? " " + tone : ""), text);
  }

  function render() {
    var opts = options();
    var season = seasonInfo();
    rail.textContent = "";

    // The season picks card went away (for example: the window closed and there is nothing to show): back to the sessions.
    if (!season && state.view === "season") {
      state.view = "session";
      pl.setAttribute("data-view", "session");
    }

    if (opts.length === 0 && !season) {
      pl.classList.add("no-rail");
      banner.hidden = true;
      return;
    }
    pl.classList.remove("no-rail");

    var current = null;
    for (var c = 0; c < opts.length; c++) { if (opts[c].id === select.value) { current = opts[c]; } }
    if (!current && opts.length) { current = opts[0]; }

    // No open session (for example: only season picks are open): show the season picks.
    if (opts.length === 0 && state.view === "session") {
      state.view = "season";
      pl.setAttribute("data-view", "season");
    }

    if (opts.length) {
      headEv.textContent = current.event;
      headTy.textContent = current.type;

      var events = [];
      opts.forEach(function (o) { if (events.indexOf(o.event) === -1) { events.push(o.event); } });
      var eventIndex = events.indexOf(current.event);

      function todo(eventName) {
        return opts.filter(function (o) { return o.event === eventName && !state.saved[o.id]; }).length;
      }

      var eventCard = el("section", "pl-card pl-event");
      eventCard.appendChild(el("span", "pl-label", "Grand Prix"));
      var row = el("div", "pl-event-row");
      var prev = el("button", "pl-nav-btn", "\u2039");
      prev.type = "button";
      prev.setAttribute("aria-label", "Previous Grand Prix");
      prev.disabled = eventIndex <= 0;
      var next = el("button", "pl-nav-btn", "\u203a");
      next.type = "button";
      next.setAttribute("aria-label", "Next Grand Prix");
      next.disabled = eventIndex >= events.length - 1;
      var sel = el("select", "pl-event-select");
      sel.setAttribute("aria-label", "Grand Prix");
      events.forEach(function (name) {
        var opt = document.createElement("option");
        opt.value = name;
        var n = todo(name);
        opt.textContent = name + (n > 0 ? "  (" + n + " to do)" : "");
        sel.appendChild(opt);
      });
      sel.value = current.event;
      row.appendChild(prev);
      row.appendChild(sel);
      row.appendChild(next);
      eventCard.appendChild(row);
      var n = todo(current.event);
      eventCard.appendChild(el("p", "pl-event-sub", n > 0 ? n + (n === 1 ? " session to do" : " sessions to do") : "Everything saved for this weekend"));
      rail.appendChild(eventCard);

      function goEvent(name) {
        var inEvent = opts.filter(function (o) { return o.event === name; });
        var first = inEvent.filter(function (o) { return !state.saved[o.id]; })[0] || inEvent[0];
        if (first) { choose(first.id); }
      }
      sel.addEventListener("change", function () { goEvent(sel.value); });
      prev.addEventListener("click", function () { goEvent(events[eventIndex - 1]); });
      next.addEventListener("click", function () { goEvent(events[eventIndex + 1]); });
    }

    var listCard = el("section", "pl-card");
    var list = el("ul", "pl-sessions");
    opts.filter(function (o) { return o.event === (current && current.event); }).forEach(function (o) {
      var li = document.createElement("li");
      var btn = el("button", "pl-sess");
      btn.type = "button";
      btn.setAttribute("data-id", o.id);
      btn.setAttribute("aria-current", state.view === "session" && o.id === select.value ? "true" : "false");
      btn.appendChild(el("span", "pl-sess-name", o.type));
      var meta = el("span", "pl-sess-meta");
      meta.appendChild(state.saved[o.id] ? chip("Saved", "is-saved") : chip("To do", "is-todo"));
      var w = state.windows[o.id];
      if (w && w.lockMs) {
        var left = w.lockMs - Date.now();
        if (left > 0) { meta.appendChild(el("span", "pl-lock", "Locks in " + untilText(left))); }
      }
      btn.appendChild(meta);
      btn.addEventListener("click", function () { choose(o.id); });
      li.appendChild(btn);
      list.appendChild(li);
    });

    if (season) {
      var sli = el("li", "pl-season-item");
      var sbtn = el("button", "pl-sess");
      sbtn.type = "button";
      sbtn.setAttribute("aria-current", state.view === "season" ? "true" : "false");
      sbtn.appendChild(el("span", "pl-sess-name", "Season picks"));
      var smeta = el("span", "pl-sess-meta");
      smeta.appendChild(chip(season.label, season.tone));
      if (season.sub) { smeta.appendChild(el("span", "pl-lock", season.sub)); }
      sbtn.appendChild(smeta);
      sbtn.addEventListener("click", function () { setView("season"); });
      sli.appendChild(sbtn);
      list.appendChild(sli);
    }
    listCard.appendChild(list);
    rail.appendChild(listCard);

    // One banner while season picks are open and not saved yet.
    banner.hidden = !(season && season.kind === "open" && !season.saved && state.view !== "season");

    pl.classList.add("shell-ready");
  }

  // ----- keep in step with the page -----
  select.addEventListener("change", function () { state.view = "session"; pl.setAttribute("data-view", "session"); render(); });
  new MutationObserver(render).observe(select, { childList: true });
  if (seasonCard) {
    new MutationObserver(render).observe(seasonCard, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true, characterData: true });
  }
  if (pickStatus) {
    new MutationObserver(function () {
      if (pickStatus.getAttribute("data-kind") === "saved" && select.value && !state.saved[select.value]) {
        state.saved[select.value] = true;
        render();
      }
    }).observe(pickStatus, { attributes: true, childList: true, characterData: true, subtree: true });
  }
  if (bannerBtn) { bannerBtn.addEventListener("click", function () { setView("season"); }); }

  // ----- status of every open session: saved or not, and when it locks -----
  function loadStatus() {
    if (!client) { return; }
    client.auth.getSession().then(function (result) {
      var session = result.data && result.data.session;
      if (!session) { return null; }
      return Promise.all([
        client.from("prediction_windows").select("session_id, lock_at, is_open").eq("is_open", true),
        client.from("predictions").select("session_id").eq("user_id", session.user.id)
      ]).then(function (res) {
        if (res[0].error || res[1].error) { return; }
        state.windows = {};
        (res[0].data || []).forEach(function (w) { state.windows[w.session_id] = { lockMs: w.lock_at ? Date.parse(w.lock_at) : null }; });
        var saved = {};
        (res[1].data || []).forEach(function (p) { saved[p.session_id] = true; });
        Object.keys(state.saved).forEach(function (id) { if (state.saved[id]) { saved[id] = true; } });
        state.saved = saved;
        render();
      });
    }).catch(function (err) { console.error(err); });
  }

  window.setInterval(render, 60000);
  window.setInterval(loadStatus, 120000);
  render();
  loadStatus();
})();
