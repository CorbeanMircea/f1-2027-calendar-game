// Lights Out: the maths behind the picks reveal. Counts what the players picked.
// Pure functions, no network. Used by picks.js.
(function (root) {
  "use strict";

  function list(obj, key) {
    var v = obj ? obj[key] : null;
    return Array.isArray(v) ? v : [];
  }

  // [{id, count}] sorted by votes, then by id so the order never jumps around.
  function ranked(map) {
    return Object.keys(map).map(function (id) { return { id: id, count: map[id] }; })
      .sort(function (a, b) { return b.count - a.count || (a.id < b.id ? -1 : 1); });
  }

  function groupRows(lists) {
    var votes = {};
    lists.forEach(function (l) {
      var seen = {};
      l.forEach(function (id) { if (!seen[id]) { seen[id] = true; votes[id] = (votes[id] || 0) + 1; } });
    });
    return ranked(votes);
  }

  function orderedRows(lists, size) {
    var rows = [];
    for (var i = 0; i < size; i++) {
      var votes = {};
      lists.forEach(function (l) { if (l[i]) { votes[l[i]] = (votes[l[i]] || 0) + 1; } });
      var r = ranked(votes);
      rows.push({ pos: i + 1, top: r[0] || null, others: r.slice(1) });
    }
    return rows;
  }

  function dnfList(p) {
    if (Array.isArray(p.dnf_drivers)) { return p.dnf_drivers; }
    return p.dnf_driver ? [p.dnf_driver] : [];
  }

  // byUser: { userId: picks }. Returns the sections shown in "the room's view".
  function summarize(type, byUser) {
    var users = Object.keys(byUser);
    var picks = users.map(function (u) { return byUser[u]; });
    var total = users.length;
    var out = { total: total, sections: [] };

    if (type === "qualifying" || type === "sprint_qualifying") {
      out.sections.push({ key: "q1", title: "Knocked out in Q1", kind: "group", rows: groupRows(picks.map(function (p) { return list(p, "q1_out"); })) });
      out.sections.push({ key: "q2", title: "Knocked out in Q2", kind: "group", rows: groupRows(picks.map(function (p) { return list(p, "q2_out"); })) });
      out.sections.push({ key: "q3", title: "Q3 order", kind: "ordered", rows: orderedRows(picks.map(function (p) { return list(p, "q3_order"); }), 10) });
      return out;
    }

    out.sections.push({ key: "top8", title: "Top 8 order", kind: "ordered", rows: orderedRows(picks.map(function (p) { return list(p, "top8"); }), 8) });
    if (type === "race") {
      out.sections.push({ key: "fl", title: "Fastest lap", kind: "group",
        rows: groupRows(picks.map(function (p) { return p.fastest_lap ? [p.fastest_lap] : []; })) });

      var counts = {};
      picks.forEach(function (p) {
        var n = p.any_dnf ? Number(p.dnf_count) || 0 : 0;
        counts[n] = (counts[n] || 0) + 1;
      });
      out.sections.push({ key: "dnfcount", title: "How many DNFs?", kind: "count",
        rows: Object.keys(counts).map(Number).sort(function (a, b) { return a - b; })
          .map(function (n) { return { label: n === 0 ? "No DNFs" : n + (n === 1 ? " DNF" : " DNFs"), count: counts[n] }; }) });

      var dnfRows = groupRows(picks.map(dnfList));
      if (dnfRows.length > 0) {
        out.sections.push({ key: "dnf", title: "DNF drivers", kind: "group", rows: dnfRows });
      }
    }
    return out;
  }

  // For one player's card: which of their picks did nobody else make?
  // ordered lists compare the same position, group lists compare the driver anywhere in the list.
  function onlyPicks(userId, key, mode, byUser, getList) {
    var mine = getList(byUser[userId]);
    var others = Object.keys(byUser).filter(function (u) { return u !== userId; }).map(function (u) { return getList(byUser[u]); });
    return mine.map(function (id, i) {
      if (others.length === 0) { return false; }
      return !others.some(function (l) { return mode === "slot" ? l[i] === id : l.indexOf(id) !== -1; });
    });
  }

  root.LO_PICKS = { summarize: summarize, onlyPicks: onlyPicks, list: list, dnfList: dnfList };
  if (typeof module !== "undefined" && module.exports) { module.exports = root.LO_PICKS; }
})(typeof window !== "undefined" ? window : this);
