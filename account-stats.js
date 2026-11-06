// Lights Out: season statistics on the Account page.
// Reads the read-only views from migration 023 (player_season_stats, player_event_progress).
// It wraps AccountProfile.render/clear so account.js and account-profile.js stay untouched.
(function () {
  "use strict";

  var card = document.getElementById("stats-card");
  var AP = window.AccountProfile;
  if (!card || !AP) { return; }

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    seasonWrap: $("stats-season-wrap"), season: $("stats-season"), state: $("stats-state"), body: $("stats-body"),
    points: $("st-points"), pointsSub: $("st-points-sub"), rank: $("st-rank"), rankSub: $("st-rank-sub"),
    acc: $("st-acc"), accSub: $("st-acc-sub"), chart: $("stats-chart"), legend: $("stats-legend"),
    types: $("stats-types"), grid: $("stats-grid"), rounds: $("stats-rounds")
  };

  var state = { client: null, user: null, token: 0, season: null };

  // ---------- Helpers ----------

  function fmt(n) { return Number(n).toLocaleString("en-GB"); }

  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function pct(v, whole) {
    if (v === null || v === undefined) { return "\u2013"; }
    var n = Number(v);
    return (whole ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "")) + "%";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function showState(text) {
    els.state.textContent = text || "";
    els.state.hidden = !text;
  }

  // ---------- Chart (inline SVG, no libraries) ----------

  function niceStep(max) {
    var steps = [10, 25, 50, 100, 250, 500, 1000, 2500];
    for (var i = 0; i < steps.length; i++) { if (max / steps[i] <= 4) { return steps[i]; } }
    return 5000;
  }

  function drawChart(progress, uid) {
    var rounds = [];
    var names = {};
    var series = {};
    progress.forEach(function (r) {
      if (rounds.indexOf(r.round) === -1) { rounds.push(r.round); }
      names[r.round] = r.event_name;
      (series[r.user_id] = series[r.user_id] || {})[r.round] = r;
    });
    rounds.sort(function (a, b) { return a - b; });
    var n = rounds.length;
    if (n === 0) { return ""; }

    var max = 0;
    progress.forEach(function (r) { if (r.cumulative_points > max) { max = r.cumulative_points; } });
    var step = niceStep(Math.max(max, 1));
    var yMax = Math.max(step, Math.ceil(max / step) * step);

    var W = 480, H = 240, L = 44, R = 20, T = 20, B = 34;
    var pw = W - L - R, ph = H - T - B;
    function x(i) { return n === 1 ? L + pw / 2 : L + (i * pw) / (n - 1); }
    function y(v) { return T + ph - (v / yMax) * ph; }

    var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Points progression by round">';

    for (var t = 0; t <= yMax; t += step) {
      out += '<line class="ch-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>' +
        '<text class="ch-axis" x="' + (L - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + t + "</text>";
    }

    var every = n <= 8 ? 1 : Math.ceil(n / 8);
    rounds.forEach(function (rd, i) {
      if (i % every === 0 || i === n - 1) {
        out += '<text class="ch-axis" x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle">R' + rd + "</text>";
      }
    });

    function pathFor(uidKey) {
      var d = "";
      var last = 0;
      rounds.forEach(function (rd, i) {
        var row = series[uidKey] && series[uidKey][rd];
        if (row) { last = row.cumulative_points; }
        d += (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(last).toFixed(1) + " ";
      });
      return d;
    }

    Object.keys(series).forEach(function (key) {
      if (key === uid) { return; }
      if (n > 1) { out += '<path class="ch-other" d="' + pathFor(key) + '"/>'; }
      else {
        var row = series[key][rounds[0]];
        if (row) { out += '<circle class="ch-dot-other" cx="' + x(0) + '" cy="' + y(row.cumulative_points) + '" r="3"/>'; }
      }
    });

    if (series[uid]) {
      if (n > 1) { out += '<path class="ch-me" d="' + pathFor(uid) + '"/>'; }
      rounds.forEach(function (rd, i) {
        var row = series[uid][rd];
        if (!row) { return; }
        out += '<circle class="ch-dot" cx="' + x(i) + '" cy="' + y(row.cumulative_points) + '" r="5"><title>' +
          esc("Round " + rd + " \u00b7 " + (names[rd] || "") + ": " + row.cumulative_points + " pts, " + ordinal(row.season_rank)) + "</title></circle>";
        if (i === n - 1) {
          out += '<text class="ch-value" x="' + x(i) + '" y="' + (y(row.cumulative_points) - 12) + '" text-anchor="' +
            (n > 1 ? "end" : "middle") + '">' + row.cumulative_points + "</text>";
        }
      });
    }
    return out + "</svg>";
  }

  // ---------- Render ----------

  function renderHero(mine, all) {
    els.points.textContent = fmt(mine.total_points);
    els.pointsSub.textContent = fmt(mine.sessions_scored) + (mine.sessions_scored === 1 ? " session scored" : " sessions scored");

    els.rank.textContent = ordinal(mine.season_rank);
    var of = el("span", "of", " of " + all.length);
    els.rank.appendChild(of);
    var best = 0;
    var second = null;
    all.forEach(function (p) { if (p.total_points > best) { best = p.total_points; } });
    if (mine.season_rank > 1) {
      els.rankSub.textContent = fmt(best - mine.total_points) + " pts behind the leader";
    } else {
      all.forEach(function (p) {
        if (p.user_id !== mine.user_id && (second === null || p.total_points > second)) { second = p.total_points; }
      });
      els.rankSub.textContent = second === null ? "" : fmt(mine.total_points - second) + " pts clear of 2nd";
    }

    els.acc.textContent = pct(mine.placed_accuracy, true);
    els.accSub.textContent = "Exact positions " + pct(mine.exact_accuracy, true);
  }

  function renderTypes(mine) {
    els.types.textContent = "";
    var defs = [
      { name: "Qualifying", note: "incl. sprint qualifying", pts: mine.points_qualifying, n: mine.sessions_qualifying, acc: mine.accuracy_qualifying },
      { name: "Race", note: "", pts: mine.points_race, n: mine.sessions_race, acc: mine.accuracy_race },
      { name: "Sprint", note: "", pts: mine.points_sprint, n: mine.sessions_sprint, acc: mine.accuracy_sprint }
    ];
    defs.forEach(function (d) {
      if (!d.n) { return; }
      var li = el("li");
      var row = el("div", "st-row");
      var left = el("div");
      left.appendChild(el("div", "st-name", d.name));
      left.appendChild(el("div", "st-meta", fmt(d.pts) + " pts \u00b7 " + d.n + (d.n === 1 ? " session" : " sessions") + (d.note ? " \u00b7 " + d.note : "")));
      row.appendChild(left);
      row.appendChild(el("div", "st-pct", pct(d.acc, true)));
      li.appendChild(row);
      var bar = el("div", "st-bar");
      var fill = el("span", "st-fill");
      fill.style.width = (d.acc === null || d.acc === undefined ? 0 : Math.max(0, Math.min(100, Number(d.acc)))) + "%";
      bar.appendChild(fill);
      li.appendChild(bar);
      els.types.appendChild(li);
    });
  }

  function renderGrid(mine) {
    els.grid.textContent = "";
    var items = [
      ["Best session", fmt(mine.best_session), "pts"],
      ["Average", mine.avg_points === null ? "\u2013" : Number(mine.avg_points).toFixed(1).replace(/\.0$/, ""), "pts"],
      ["Session wins", fmt(mine.session_wins), ""],
      ["Perfect orders", fmt(mine.perfect_orders), ""],
      ["Fastest laps called", fmt(mine.fastest_lap_hits), mine.sessions_race ? "of " + mine.sessions_race : ""],
      ["Points from DNF picks", fmt(mine.dnf_points), "pts"]
    ];
    items.forEach(function (it) {
      var box = el("div");
      box.appendChild(el("dt", "", it[0]));
      var dd = el("dd", "", it[1]);
      if (it[2]) { dd.appendChild(document.createTextNode(" ")); dd.appendChild(el("small", "", it[2])); }
      box.appendChild(dd);
      els.grid.appendChild(box);
    });
  }

  function renderRounds(progress, uid) {
    els.rounds.textContent = "";
    progress.filter(function (r) { return r.user_id === uid; }).forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("td", "", "R" + r.round));
      tr.appendChild(el("td", "", r.event_name));
      tr.appendChild(el("td", "", (r.event_points > 0 ? "+" : "") + r.event_points));
      tr.appendChild(el("td", "", fmt(r.cumulative_points)));
      tr.appendChild(el("td", "", ordinal(r.season_rank)));
      els.rounds.appendChild(tr);
    });
  }

  function renderSeason(token, rows, progress) {
    if (token !== state.token) { return; }
    var uid = state.user.id;
    var mine = null;
    rows.forEach(function (r) { if (r.user_id === uid) { mine = r; } });
    if (!mine) {
      els.body.hidden = true;
      showState("No scored sessions in this season yet. Statistics appear after an admin approves a result.");
      return;
    }
    showState("");
    renderHero(mine, rows);
    els.chart.innerHTML = drawChart(progress, uid);
    els.legend.innerHTML = '<span class="lg-me">You</span>' + (rows.length > 1 ? "<span>Other players</span>" : "");
    renderTypes(mine);
    renderGrid(mine);
    renderRounds(progress, uid);
    els.body.hidden = false;
  }

  function failure(err) {
    console.error(err);
    var text = (err && (err.message || "")) + " " + (err && err.code || "");
    els.body.hidden = true;
    showState(/does not exist|schema cache|PGRST20[0-9]|42P01/i.test(text)
      ? "Statistics need the latest database update (023_player_stats.sql)."
      : "Could not load statistics. Please reload the page.");
  }

  // ---------- Loading ----------

  function loadSeason(season, token) {
    state.season = season;
    return Promise.all([
      state.client.from("player_season_stats").select("*").eq("season", season),
      state.client.from("player_event_progress")
        .select("season, round, event_name, user_id, event_points, cumulative_points, season_rank")
        .eq("season", season).order("round", { ascending: true })
    ]).then(function (res) {
      if (token !== state.token) { return; }
      if (res[0].error || res[1].error) { return failure(res[0].error || res[1].error); }
      renderSeason(token, res[0].data || [], res[1].data || []);
    });
  }

  function start(client, user) {
    state.client = client;
    state.user = user;
    state.token++;
    var token = state.token;
    card.hidden = false;
    els.body.hidden = true;
    showState("Loading statistics...");

    client.from("player_season_stats").select("season").eq("user_id", user.id).order("season", { ascending: false })
      .then(function (res) {
        if (token !== state.token) { return; }
        if (res.error) { return failure(res.error); }
        var seasons = (res.data || []).map(function (r) { return r.season; });
        if (seasons.length === 0) {
          els.seasonWrap.hidden = true;
          showState("No scored sessions yet. Statistics appear after an admin approves a result.");
          return;
        }
        var chosen = seasons.indexOf(state.season) !== -1 ? state.season : seasons[0];
        els.season.textContent = "";
        seasons.forEach(function (s) {
          var o = document.createElement("option");
          o.value = String(s);
          o.textContent = String(s);
          if (s === chosen) { o.selected = true; }
          els.season.appendChild(o);
        });
        els.seasonWrap.hidden = seasons.length < 2;
        return loadSeason(chosen, token);
      }).catch(failure);
  }

  els.season.addEventListener("change", function () {
    if (!state.client || !state.user) { return; }
    state.token++;
    showState("Loading statistics...");
    els.body.hidden = true;
    loadSeason(parseInt(els.season.value, 10), state.token).catch(failure);
  });

  function clear() {
    state.token++;
    state.user = null;
    state.season = null;
    card.hidden = true;
    els.body.hidden = true;
    els.chart.textContent = "";
  }

  // ---------- Hook into the existing profile card ----------

  var origRender = AP.render;
  var origClear = AP.clear;
  AP.render = function (client, user) {
    origRender.apply(AP, arguments);
    start(client, user);
  };
  AP.clear = function () {
    origClear.apply(AP, arguments);
    clear();
  };
})();