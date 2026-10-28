// Lights Out: the driver card on the Account page (avatar, level, rank, XP).
// account.js calls render() once the player is a group member and clear() on sign-out.
// Needs lo-profile.js. If the database update (019) has not been run yet, the page still
// works: XP is added up from scores and the avatar is a generated default.
(function () {
  "use strict";

  var P = window.LO_PROFILE;
  var card = document.getElementById("driver-card");
  if (!P || !card) { return; }

  var TYPE_LABEL = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    levelup: $("levelup"), levelupText: $("levelup-text"), levelupClose: $("levelup-close"),
    avatar: $("driver-avatar"), badge: $("driver-badge"), name: $("driver-name"), rank: $("driver-rank"),
    bar: $("xp-bar"), fill: $("xp-fill"), left: $("xp-left"), right: $("xp-right"),
    edit: $("edit-avatar"),
    sXp: $("stat-xp"), sSessions: $("stat-sessions"), sBest: $("stat-best"), sAvg: $("stat-avg"),
    ladder: $("ladder"), recent: $("recent-list"),
    picker: $("avatar-picker"), pkPreview: $("picker-preview"), pkPatterns: $("pk-patterns"),
    pkColours: $("pk-colours"), pkBases: $("pk-bases"), pkVisors: $("pk-visors"), pkStyles: $("pk-styles"),
    pkRandom: $("picker-random"), pkNumber: $("pk-number"), pkSave: $("picker-save"),
    pkCancel: $("picker-cancel"), pkMsg: $("picker-msg")
  };

  var state = { client: null, user: null, avatar: null, draft: null };

  function reduced() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function fmt(n) { return Number(n).toLocaleString("en-GB"); }

  function countUp(node, to) {
    if (reduced() || to === 0) { node.textContent = fmt(to); return; }
    var start = null;
    function frame(t) {
      if (start === null) { start = t; }
      var p = Math.min(1, (t - start) / 900);
      node.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) { window.requestAnimationFrame(frame); }
    }
    window.requestAnimationFrame(frame);
  }

  // ---------- Card ----------

  function drawAvatar() {
    var a = state.avatar || P.defaultAvatar(state.user.id);
    els.avatar.innerHTML = P.avatarSvg(a, 112);
  }

  function drawLevel(xp, sessions, best) {
    var lv = P.levelFor(xp);
    var rank = P.rankFor(lv.level);

    els.badge.innerHTML = P.badgeSvg(rank.tier, 44);
    els.rank.innerHTML = "<b>Level " + lv.level + "</b> \u00b7 " + rank.name;
    els.left.innerHTML = lv.maxed ? "<b>" + fmt(lv.xp) + "</b> XP" : "<b>" + fmt(lv.into) + "</b> / " + fmt(lv.ceil - lv.floor) + " XP";
    els.right.textContent = lv.maxed ? "Maximum level" : fmt(lv.toNext) + " XP to Level " + (lv.level + 1);
    els.bar.setAttribute("aria-valuenow", String(Math.round(lv.progress * 100)));
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { els.fill.style.width = Math.round(lv.progress * 100) + "%"; });
    });

    countUp(els.sXp, lv.xp);
    els.sSessions.textContent = fmt(sessions);
    els.sBest.textContent = fmt(best);
    els.sAvg.textContent = sessions > 0 ? fmt(Math.round(lv.xp / sessions)) : "0";

    // Rank ladder: shows how the badge changes as the player climbs.
    var html = "";
    P.RANKS.forEach(function (r, i) {
      var cls = i < rank.tier ? "is-done" : (i === rank.tier ? "is-current" : "");
      html += '<li class="' + cls + '">' + P.badgeSvg(i, 40) + '<span class="rl-name">' + r.name +
        '</span><span class="rl-lv">LV ' + r.from + "+</span></li>";
    });
    els.ladder.innerHTML = html;

    // Level up: compare with the level seen on the last visit.
    var key = "lo-level-" + state.user.id;
    var seen = null;
    try { seen = parseInt(window.localStorage.getItem(key), 10); } catch (e) { seen = null; }
    if (seen && lv.level > seen) {
      var prevTier = P.tierFor(seen);
      els.levelupText.textContent = "You reached Level " + lv.level + (rank.tier > prevTier ? " \u00b7 New rank: " + rank.name : "") + ".";
      els.levelup.hidden = false;
    }
    try { window.localStorage.setItem(key, String(lv.level)); } catch (e) { /* ignore */ }
  }

  function drawRecent(rows) {
    if (!rows || rows.length === 0) {
      els.recent.innerHTML = '<li class="rc-empty">No scored sessions yet. XP arrives after an admin approves a result.</li>';
      return;
    }
    els.recent.textContent = "";
    rows.forEach(function (row) {
      var s = row.sessions;
      if (Array.isArray(s)) { s = s[0]; }
      var ev = s && s.events;
      if (Array.isArray(ev)) { ev = ev[0]; }
      var label = (ev && ev.name ? ev.name : "Session") + " \u00b7 " + ((s && TYPE_LABEL[s.session_type]) || "");
      var li = document.createElement("li");
      var a = document.createElement("span");
      a.textContent = label.replace(/ \u00b7 $/, "");
      var b = document.createElement("span");
      b.className = "rc-gain";
      b.textContent = "+" + row.points + " XP";
      li.appendChild(a);
      li.appendChild(b);
      els.recent.appendChild(li);
    });
  }

  function load() {
    var uid = state.user.id;
    var client = state.client;
    return Promise.all([
      client.from("player_xp").select("avatar, xp, sessions_scored, best_session").eq("user_id", uid).limit(1),
      client.from("scores").select("points, computed_at, sessions(session_type, events(name))")
        .eq("user_id", uid).order("computed_at", { ascending: false }).limit(5)
    ]).then(function (res) {
      if (!state.user || state.user.id !== uid) { return; }
      var xpRes = res[0];
      var recent = res[1].error ? [] : (res[1].data || []);
      var row = !xpRes.error && xpRes.data && xpRes.data[0];

      if (row) {
        state.avatar = P.parseAvatar(row.avatar);
        drawAvatar();
        drawLevel(row.xp, row.sessions_scored, row.best_session);
        drawRecent(recent);
        return;
      }
      // Database update not run yet: add up the player's own scores instead.
      return client.from("scores").select("points").eq("user_id", uid).then(function (all) {
        var rows = all.error ? [] : (all.data || []);
        var total = 0;
        var best = 0;
        rows.forEach(function (r) { total += r.points; if (r.points > best) { best = r.points; } });
        drawAvatar();
        drawLevel(total, rows.length, best);
        drawRecent(recent);
      });
    });
  }

  // ---------- Avatar picker ----------

  function swatches(list, key, selected, label) {
    var html = "";
    list.forEach(function (c, i) {
      html += '<button type="button" data-' + key + '="' + i + '" aria-pressed="' + (i === selected) + '" aria-label="' +
        label + ": " + c.name + '" title="' + c.name + '" style="background:' + c.hex + '"></button>';
    });
    return html;
  }

  function options(list, key, selected, label) {
    var html = "";
    list.forEach(function (name, i) {
      html += '<button type="button" data-' + key + '="' + i + '" aria-pressed="' + (i === selected) + '" aria-label="' +
        label + ": " + name + '">' + name + "</button>";
    });
    return html;
  }

  function drawPicker() {
    var d = state.draft;
    els.pkPreview.innerHTML = P.avatarSvg(d, 132);

    var html = "";
    P.PATTERNS.forEach(function (name, i) {
      var a = { pattern: i, colour: d.colour, base: d.base, visor: d.visor, style: d.style, number: d.number };
      html += '<button type="button" data-pattern="' + i + '" aria-pressed="' + (i === d.pattern) + '" aria-label="' + name +
        ' pattern"><span class="av-tile">' + P.avatarSvg(a, 64) + "</span></button>";
    });
    els.pkPatterns.innerHTML = html;
    els.pkBases.innerHTML = swatches(P.BASES, "base", d.base, "Shell");
    els.pkColours.innerHTML = swatches(P.COLOURS, "colour", d.colour, "Pattern");
    els.pkVisors.innerHTML = options(P.VISORS.map(function (v) { return v.name; }), "visor", d.visor, "Visor");
    els.pkStyles.innerHTML = options(P.STYLES, "style", d.style, "Number plate");
    els.pkNumber.value = String(d.number);
  }

  function openPicker() {
    var a = state.avatar || P.defaultAvatar(state.user.id);
    state.draft = { pattern: a.pattern, colour: a.colour, base: a.base || 0, visor: a.visor || 0, style: a.style || 0, number: a.number };
    els.pkMsg.textContent = "";
    drawPicker();
    els.picker.hidden = false;
    els.edit.setAttribute("aria-expanded", "true");
  }

  function closePicker() {
    els.picker.hidden = true;
    els.edit.setAttribute("aria-expanded", "false");
  }

  els.edit.addEventListener("click", function () { if (els.picker.hidden) { openPicker(); } else { closePicker(); } });
  els.pkCancel.addEventListener("click", closePicker);
  els.levelupClose.addEventListener("click", function () { els.levelup.hidden = true; });

  els.pkPatterns.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-pattern]");
    if (!b) { return; }
    state.draft.pattern = parseInt(b.getAttribute("data-pattern"), 10);
    drawPicker();
  });

  els.pkColours.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-colour]");
    if (!b) { return; }
    state.draft.colour = parseInt(b.getAttribute("data-colour"), 10);
    drawPicker();
  });

  function pick(box, attr, field) {
    box.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-" + attr + "]");
      if (!b) { return; }
      state.draft[field] = parseInt(b.getAttribute("data-" + attr), 10);
      drawPicker();
    });
  }

  pick(els.pkBases, "base", "base");
  pick(els.pkVisors, "visor", "visor");
  pick(els.pkStyles, "style", "style");

  els.pkRandom.addEventListener("click", function () {
    state.draft = P.randomAvatar();
    drawPicker();
  });

  els.pkNumber.addEventListener("input", function () {
    var n = parseInt(els.pkNumber.value, 10);
    if (isNaN(n)) { return; }
    state.draft.number = Math.max(1, Math.min(99, n));
    els.pkPreview.innerHTML = P.avatarSvg(state.draft, 132);
  });

  els.pkNumber.addEventListener("change", function () {
    els.pkNumber.value = String(state.draft.number);
    drawPicker();
  });

  els.pkSave.addEventListener("click", function () {
    var code = P.buildCode(state.draft);
    els.pkSave.disabled = true;
    els.pkMsg.textContent = "Saving...";
    state.client.rpc("set_avatar", { p_avatar: code }).then(function (res) {
      els.pkSave.disabled = false;
      if (res.error) {
        console.error(res.error);
        var why = res.error.message || "unknown error";
        var missing = /schema cache|could not find|does not exist|PGRST202|42883/i.test(why + " " + (res.error.code || ""));
        els.pkMsg.textContent = missing
          ? "Saving is not available yet: the database update (019_avatars_xp.sql) has not been run in Supabase. (" + why + ")"
          : "Could not save the avatar: " + why;
        return;
      }
      state.avatar = P.parseAvatar(code);
      drawAvatar();
      els.pkMsg.textContent = "";
      closePicker();
    }).catch(function (err) {
      els.pkSave.disabled = false;
      console.error(err);
      els.pkMsg.textContent = "Something went wrong. Please try again.";
    });
  });

  // ---------- Public ----------

  window.AccountProfile = {
    render: function (client, user, displayName) {
      state.client = client;
      state.user = user;
      state.avatar = null;
      els.name.textContent = displayName || "Driver";
      els.levelup.hidden = true;
      closePicker();
      card.hidden = false;
      load().catch(function (err) { console.error(err); });
    },
    clear: function () {
      state.user = null;
      card.hidden = true;
      els.fill.style.width = "0";
    }
  };
})();
