// Lights Out: score explainer. Recomputes a session score from the picks and the approved
// result using the same rules as the database (calc_points), and says where every point
// came from. Pure functions, no network. Used by scorecard.js.
(function (root) {
  "use strict";

  function list(obj, key) {
    var v = obj ? obj[key] : null;
    return Array.isArray(v) ? v : [];
  }

  function idx(arr, id) { return arr.indexOf(id); }

  // A row: label (P1, ...), pick, actual, what it earned and a state used for styling.
  function row(label, pick, actual, points, state, pickWhy, actualWhy) {
    return { label: label, pick: pick, actual: actual, points: points, state: state, pickWhy: pickWhy || "", actualWhy: actualWhy || "" };
  }
  function drv(id) { return id ? { id: id } : null; }
  function txt(text) { return { text: text }; }

  function qualifying(picks, actual) {
    var q1a = list(actual, "q1_out");
    var q2a = list(actual, "q2_out");
    var q3a = list(actual, "q3_order");
    var group = 0;
    var exactN = 0;

    var rows1 = list(picks, "q1_out").map(function (id) {
      var hit = idx(q1a, id) !== -1;
      if (hit) { group++; }
      return row("", drv(id), null, hit ? 1 : 0, hit ? "hit" : "miss", hit ? "Knocked out in Q1" : "Was not knocked out in Q1");
    });
    var rows2 = list(picks, "q2_out").map(function (id) {
      var hit = idx(q2a, id) !== -1;
      if (hit) { group++; }
      return row("", drv(id), null, hit ? 1 : 0, hit ? "hit" : "miss", hit ? "Knocked out in Q2" : "Was not knocked out in Q2");
    });
    var rows3 = list(picks, "q3_order").map(function (id, i) {
      var a = q3a[i];
      var pos = idx(q3a, id);
      if (id === a) { group++; exactN++; return row("P" + (i + 1), drv(id), drv(a), 4, "hit", "Exact position: 1 for reaching Q3 + 3 for the position"); }
      if (pos !== -1) { group++; return row("P" + (i + 1), drv(id), drv(a), 1, "part", "Reached Q3 but was P" + (pos + 1) + ": 1 point"); }
      return row("P" + (i + 1), drv(id), drv(a), 0, "miss", "Did not reach Q3");
    });
    var bonus = exactN === 10 ? 10 : 0;
    var sum = function (rows) { return rows.reduce(function (t, r) { return t + r.points; }, 0); };

    var sections = [
      { key: "q1", title: "Knocked out in Q1", note: "1 point for each driver you picked who really went out in Q1.",
        actualText: "Actual: ", actualList: q1a, rows: rows1, subtotal: sum(rows1) },
      { key: "q2", title: "Knocked out in Q2", note: "1 point for each driver you picked who really went out in Q2.",
        actualText: "Actual: ", actualList: q2a, rows: rows2, subtotal: sum(rows2) },
      { key: "q3", title: "Q3 order", note: "1 point for each driver who reached Q3, plus 3 more for the exact position.",
        rows: rows3, subtotal: sum(rows3) }
    ];
    if (bonus > 0) {
      sections.push({ key: "bonus", title: "Perfect Q3 order", note: "All 10 positions exactly right.",
        rows: [row("", txt("Perfect top 10"), null, 10, "hit")], subtotal: 10 });
    }
    return {
      sections: sections,
      components: { group: group, exact: exactN * 3, bonus: bonus },
      total: group + exactN * 3 + bonus
    };
  }

  function top8Rows(picks, actual, exactPts, nearPts) {
    var act = list(actual, "top8");
    var exactN = 0;
    var nearN = 0;
    var rows = list(picks, "top8").map(function (id, i) {
      var a = act[i];
      var pos = idx(act, id);
      if (id === a) { exactN++; return row("P" + (i + 1), drv(id), drv(a), exactPts, "hit", "Exact position"); }
      if (pos !== -1) { nearN++; return row("P" + (i + 1), drv(id), drv(a), nearPts, "part", "In the top 8 but finished P" + (pos + 1)); }
      return row("P" + (i + 1), drv(id), drv(a), 0, "miss", "Not in the top 8");
    });
    return { rows: rows, exactN: exactN, nearN: nearN };
  }

  function sprint(picks, actual) {
    var t = top8Rows(picks, actual, 3, 1);
    var bonus = t.exactN === 8 ? 8 : 0;
    var sections = [{ key: "top8", title: "Top 8 order", note: "3 points for an exact position, 1 point for a driver who finished in the top 8 in another place.",
      rows: t.rows, subtotal: t.exactN * 3 + t.nearN }];
    if (bonus > 0) {
      sections.push({ key: "bonus", title: "Perfect top 8", note: "All 8 positions exactly right.",
        rows: [row("", txt("Perfect top 8"), null, 8, "hit")], subtotal: 8 });
    }
    return {
      sections: sections,
      components: { exact: t.exactN * 3, in_top8: t.nearN, bonus: bonus },
      total: t.exactN * 3 + t.nearN + bonus
    };
  }

  function race(picks, actual) {
    var t = top8Rows(picks, actual, 5, 2);
    var bonus = t.exactN === 8 ? 15 : 0;
    var sections = [{ key: "top8", title: "Top 8 order", note: "5 points for an exact position, 2 points for a driver who finished in the top 8 in another place.",
      rows: t.rows, subtotal: t.exactN * 5 + t.nearN * 2 }];
    if (bonus > 0) {
      sections.push({ key: "bonus", title: "Perfect top 8", note: "All 8 positions exactly right.",
        rows: [row("", txt("Perfect top 8"), null, 15, "hit")], subtotal: 15 });
    }

    var flPick = picks ? picks.fastest_lap : null;
    var flAct = actual ? actual.fastest_lap : null;
    var flPts = flPick && flPick === flAct ? 3 : 0;
    sections.push({ key: "fl", title: "Fastest lap", note: "3 points for the right driver.",
      rows: [row("", drv(flPick), drv(flAct), flPts, flPts ? "hit" : "miss")], subtotal: flPts });

    var dnfs = list(actual, "dnf_drivers");
    var grid = list(actual, "grid_top8");
    var actCount = dnfs.length;
    var predCount = picks && picks.dnf_count !== undefined && picks.dnf_count !== null ? Number(picks.dnf_count) : 0;
    var predAny = !!(picks && picks.any_dnf);
    var anyPts = predAny === (actCount > 0) ? 2 : 0;
    var countPts = predCount === actCount ? 5 : (Math.abs(predCount - actCount) === 1 ? 2 : 0);

    var picked = Array.isArray(picks && picks.dnf_drivers) ? picks.dnf_drivers
      : (picks && picks.dnf_driver ? [picks.dnf_driver] : []);
    var drvPts = 0;
    var dnfRows = [
      row("", txt(predAny ? "Yes, someone retires" : "No retirements"), txt(actCount > 0 ? "Yes, " + actCount + " retired" : "No retirements"),
        anyPts, anyPts ? "hit" : "miss", "", "Any DNF: 2 points if you were right"),
      row("", txt(String(predCount) + (predCount === 1 ? " DNF" : " DNFs")), txt(String(actCount) + (actCount === 1 ? " DNF" : " DNFs")),
        countPts, countPts === 5 ? "hit" : (countPts === 2 ? "part" : "miss"),
        countPts === 5 ? "Exactly right: 5 points" : (countPts === 2 ? "Off by one: 2 points" : "Off by two or more: 0 points"))
    ];
    picked.forEach(function (id, i) {
      var retired = idx(dnfs, id) !== -1;
      var started = idx(grid, id) !== -1;
      var pts = retired ? (started ? 8 : 4) : 0;
      drvPts += pts;
      dnfRows.push(row("DNF " + (i + 1), drv(id), null, pts, retired ? "hit" : "miss",
        retired ? (started ? "Retired, and started in the real top 8: 8 points" : "Retired: 4 points") : "Did not retire: 0 points"));
    });
    sections.push({ key: "dnf", title: "Retirements (DNF)", note: "Any DNF 2 points. The number of DNFs: 5 points if exact, 2 if off by one. Each DNF driver you picked who retired: 4 points, or 8 if he started in the real top 8.",
      actualText: "Retired: ", actualList: dnfs, rows: dnfRows, subtotal: anyPts + countPts + drvPts });

    return {
      sections: sections,
      components: { exact: t.exactN * 5, in_top8: t.nearN * 2, bonus: bonus, fastest_lap: flPts, any_dnf: anyPts, dnf_count: countPts, dnf_driver: drvPts },
      total: t.exactN * 5 + t.nearN * 2 + bonus + flPts + anyPts + countPts + drvPts
    };
  }

  function explain(type, picks, actual) {
    if (type === "qualifying" || type === "sprint_qualifying") { return qualifying(picks, actual); }
    if (type === "sprint") { return sprint(picks, actual); }
    return race(picks, actual);
  }

  var LABELS = {
    group: "Drivers in the right group", exact: "Exact positions", in_top8: "Right driver, wrong place", bonus: "Perfect-order bonus",
    fastest_lap: "Fastest lap", any_dnf: "Any DNF", dnf_count: "Number of DNFs", dnf_driver: "DNF drivers"
  };

  root.LO_SCORING = { explain: explain, LABELS: LABELS };
  if (typeof module !== "undefined" && module.exports) { module.exports = root.LO_SCORING; }
})(typeof window !== "undefined" ? window : this);
