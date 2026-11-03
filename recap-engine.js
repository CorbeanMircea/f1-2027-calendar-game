// Lights Out: the weekend recap. Works out the winner, the biggest climber, standout calls and
// level-ups from scores, picks and results. Pure functions, no network. Used by recap.js.
(function (root) {
  "use strict";

  var TYPE_LABEL = { sprint_qualifying: "Sprint Qualifying", sprint: "Sprint", qualifying: "Qualifying", race: "Race" };

  function list(obj, key) {
    var v = obj ? obj[key] : null;
    return Array.isArray(v) ? v : [];
  }

  // 1, 2, 2, 4: players on the same points share a place.
  function rankMap(totals) {
    var ids = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    var out = {};
    ids.forEach(function (id, i) { out[id] = i > 0 && totals[id] === totals[ids[i - 1]] ? out[ids[i - 1]] : i + 1; });
    return out;
  }

  function joinNames(names) {
    if (names.length <= 1) { return names.join(""); }
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  // input: { names, drivers, eventSessions:[{id,session_type}], seasonSessionIds:[ids], scores:[{user_id,session_id,points}],
  //          results:{sid:data}, predictions:{sid:{uid:picks}}, xp:{uid:lifetimeXp}, levelFor:fn }
  function buildRecap(input) {
    var names = input.names || {};
    var drivers = input.drivers || {};
    var eventIds = {};
    input.eventSessions.forEach(function (s) { eventIds[s.id] = s; });
    var seasonIds = {};
    (input.seasonSessionIds || []).forEach(function (id) { seasonIds[id] = true; });
    Object.keys(eventIds).forEach(function (id) { seasonIds[id] = true; });

    var players = Object.keys(names);
    var weekend = {};
    var before = {};
    var after = {};
    players.forEach(function (u) { weekend[u] = 0; before[u] = 0; after[u] = 0; });
    var bestSession = null;

    (input.scores || []).forEach(function (s) {
      if (!seasonIds[s.session_id] || !(s.user_id in after)) { return; }
      after[s.user_id] += s.points;
      if (eventIds[s.session_id]) {
        weekend[s.user_id] += s.points;
        if (!bestSession || s.points > bestSession.points) {
          bestSession = { id: s.user_id, type: eventIds[s.session_id].session_type, points: s.points };
        }
      } else {
        before[s.user_id] += s.points;
      }
    });

    var recap = { weekend: weekend, podium: [], winners: [], climber: null, best: null, facts: [], levelUps: [], hasPoints: false };

    // ---- weekend podium
    var wRanks = rankMap(weekend);
    var order = players.slice().sort(function (a, b) { return weekend[b] - weekend[a] || String(names[a]).localeCompare(String(names[b])); });
    recap.hasPoints = order.some(function (u) { return weekend[u] > 0; });
    recap.podium = order.filter(function (u) { return wRanks[u] <= 3 && weekend[u] > 0; })
      .map(function (u) { return { id: u, points: weekend[u], rank: wRanks[u] }; });
    recap.winners = recap.podium.filter(function (p) { return p.rank === 1; });

    // ---- biggest climber in the season table
    var rb = rankMap(before);
    var ra = rankMap(after);
    var best = null;
    players.forEach(function (u) {
      var delta = rb[u] - ra[u];
      if (delta > 0 && weekend[u] > 0 && (!best || delta > best.delta || (delta === best.delta && ra[u] < best.rankNow))) {
        best = { id: u, delta: delta, rankNow: ra[u], rankBefore: rb[u] };
      }
    });
    recap.climber = best;

    if (bestSession && bestSession.points > 0) { recap.best = bestSession; }

    // ---- facts from the picks and results
    var sessions = input.eventSessions.slice();
    var pick = ["race", "sprint", "qualifying"].map(function (t) {
      return sessions.filter(function (s) { return s.session_type === t && input.results[s.id]; })[0];
    }).filter(Boolean)[0];

    function code(id) { return drivers[id] ? drivers[id].code : String(id); }
    function nameOf(u) { return names[u] || "Player"; }

    if (pick) {
      var res = input.results[pick.id];
      var preds = (input.predictions && input.predictions[pick.id]) || {};
      var users = Object.keys(preds);
      var label = TYPE_LABEL[pick.session_type];
      var isQuali = pick.session_type === "qualifying";
      var listKey = isQuali ? "q3_order" : "top8";
      var winner = list(res, listKey)[0];

      if (winner && users.length > 0) {
        var callers = users.filter(function (u) { return list(preds[u], listKey)[0] === winner; }).map(nameOf).sort();
        var what = isQuali ? "take pole position in" : "win the";
        var target = isQuali ? label : label;
        if (callers.length === 0) {
          var votes = {};
          users.forEach(function (u) { var d = list(preds[u], listKey)[0]; if (d) { votes[d] = (votes[d] || 0) + 1; } });
          var fav = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; })[0];
          recap.facts.push("Nobody picked " + code(winner) + " to " + what + " " + target + (fav ? ". The room expected " + code(fav) + "." : "."));
        } else if (callers.length === users.length && users.length > 1) {
          recap.facts.push("Everyone picked " + code(winner) + " to " + what + " " + target + ".");
        } else if (callers.length === 1) {
          recap.facts.push(callers[0] + " was the only one to pick " + code(winner) + " to " + what + " " + target + ".");
        } else {
          recap.facts.push(joinNames(callers) + " picked " + code(winner) + " to " + what + " " + target + ".");
        }
      }

      if (pick.session_type === "race" && res.fastest_lap && users.length > 0) {
        var fl = users.filter(function (u) { return preds[u].fastest_lap === res.fastest_lap; }).map(nameOf).sort();
        recap.facts.push(fl.length === 0
          ? "Nobody picked " + code(res.fastest_lap) + " for the fastest lap."
          : joinNames(fl) + " got the fastest lap right (" + code(res.fastest_lap) + ").");
      }

      if (pick.session_type === "race" && users.length > 0) {
        var actual = list(res, "dnf_drivers").length;
        var sum = 0;
        users.forEach(function (u) { sum += preds[u].any_dnf ? Number(preds[u].dnf_count) || 0 : 0; });
        var avg = sum / users.length;
        recap.facts.push((actual === 0 ? "Nobody retired" : actual + (actual === 1 ? " driver retired" : " drivers retired")) +
          ". The room expected " + (Math.round(avg * 10) / 10) + " on average.");
      }

      // perfect predictions
      users.forEach(function (u) {
        var mine = list(preds[u], listKey);
        var real = list(res, listKey);
        if (real.length > 0 && mine.length === real.length && mine.every(function (id, i) { return id === real[i]; })) {
          recap.facts.push(nameOf(u) + " got a perfect " + (isQuali ? "Q3 order" : "top 8") + " in the " + label + "!");
        }
      });
    }

    // ---- level-ups
    if (input.xp && input.levelFor) {
      players.forEach(function (u) {
        if (typeof input.xp[u] !== "number" || weekend[u] <= 0) { return; }
        var now = input.levelFor(input.xp[u]).level;
        var was = input.levelFor(input.xp[u] - weekend[u]).level;
        if (now > was) { recap.levelUps.push({ id: u, from: was, to: now }); }
      });
    }
    return recap;
  }

  root.LO_RECAP = { buildRecap: buildRecap, rankMap: rankMap, joinNames: joinNames };
  if (typeof module !== "undefined" && module.exports) { module.exports = root.LO_RECAP; }
})(typeof window !== "undefined" ? window : this);
