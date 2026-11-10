// Lights Out: achievement badges and definitions. Pure functions, no network calls.
// Used by the badge sheet (badges.html) now and by the Account page achievements section later.
// The levels and targets below are for display on the badge sheet only: the database view
// player_achievements (migration 024) is the source of truth for progress, level and step.
(function (root) {
  "use strict";

  var C = { white: "#f3f3f0", yellow: "#ffd400", ink: "#0d0e10", plate: "#1b1e24", red: "#e0262c", line: "#4a505a" };
  var STEP_LABEL = ["I", "II", "III", "IV"];

  // ---------- Geometry helpers (all shapes are plain path data) ----------

  function n(v) { return Math.round(v * 100) / 100; }
  function rad(a) { return (a * Math.PI) / 180; }
  function polyD(pts) { return "M" + pts.map(function (p) { return n(p[0]) + " " + n(p[1]); }).join("L") + "Z"; }
  function rectD(x, y, w, h) { return polyD([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); }
  function circleD(cx, cy, r) {
    return "M" + n(cx - r) + " " + n(cy) + "a" + n(r) + " " + n(r) + " 0 1 0 " + n(2 * r) + " 0a" + n(r) + " " + n(r) + " 0 1 0 " + n(-2 * r) + " 0Z";
  }
  function ringD(cx, cy, r, w) { return circleD(cx, cy, r) + circleD(cx, cy, r - w); }
  function barD(x1, y1, x2, y2, w) {
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
    var nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
    return polyD([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
  }
  function octD(cx, cy, s, cut) {
    var h = s / 2, x = cx - h, y = cy - h;
    return polyD([[x + cut, y], [x + s - cut, y], [x + s, y + cut], [x + s, y + s - cut], [x + s - cut, y + s], [x + cut, y + s], [x, y + s - cut], [x, y + cut]]);
  }
  function pt(cx, cy, r, a) { return [cx + r * Math.cos(rad(a)), cy - r * Math.sin(rad(a))]; }
  // Annular sector between radii r1 and r2, angles in degrees (0 = right, 90 = up).
  function sectorD(cx, cy, r1, r2, a1, a2) {
    var p1 = pt(cx, cy, r2, a1), p2 = pt(cx, cy, r2, a2), p3 = pt(cx, cy, r1, a2), p4 = pt(cx, cy, r1, a1);
    var large = Math.abs(a1 - a2) > 180 ? 1 : 0;
    var sw = a2 < a1 ? 1 : 0;
    return "M" + n(p1[0]) + " " + n(p1[1]) + "A" + r2 + " " + r2 + " 0 " + large + " " + sw + " " + n(p2[0]) + " " + n(p2[1]) +
      "L" + n(p3[0]) + " " + n(p3[1]) + "A" + r1 + " " + r1 + " 0 " + large + " " + (1 - sw) + " " + n(p4[0]) + " " + n(p4[1]) + "Z";
  }

  // ---------- Painting ----------
  // c = { step: 1..4, locked: bool }. Roles: main, accent, red, dark, dim.
  // Step I and II are white on charcoal, step III adds yellow details, step IV is yellow on black.
  // A locked badge is outline only.

  function col(c, role) {
    var s = c.step;
    if (role === "main") { return s === 4 ? C.yellow : C.white; }
    if (role === "accent") { return s === 3 ? C.yellow : C.white; }
    if (role === "red") { return s >= 3 ? C.red : C.white; }
    if (role === "dark") { return s === 4 ? C.ink : C.plate; }
    return C.white;
  }

  function sh(c, d, role) {
    if (c.locked) { return role === "dark" ? "" : '<path d="' + d + '" fill="none" stroke="' + C.line + '" stroke-width="1"/>'; }
    if (role === "dim") { return '<path d="' + d + '" fill="none" stroke="' + C.line + '" stroke-width="1"/>'; }
    return '<path d="' + d + '" fill="' + col(c, role) + '" fill-rule="evenodd"/>';
  }

  function ln(c, d, role, w) {
    return '<path d="' + d + '" fill="none" stroke="' + (c.locked ? C.line : col(c, role)) + '" stroke-width="' + (c.locked ? 1 : w) +
      '" stroke-linejoin="round"/>';
  }

  // ---------- Emblems (drawn in a 40 x 40 box) ----------

  function flagCells(c, x0, y0, cols, rows, size, amp, role) {
    var out = "";
    for (var i = 0; i < cols; i++) {
      for (var r = 0; r < rows; r++) {
        if ((i + r) % 2 === 0 && (amp > 0 || i + r < cols + rows - 3)) { out += sh(c, rectD(x0 + i * size, y0 + r * size, size, size), role); }
      }
    }
    return out;
  }

  var ONE = [[5, 0], [14, 0], [14, 28], [18, 28], [18, 32], [3, 32], [3, 28], [7, 28], [7, 9], [0, 12], [0, 6]];

  var SEG = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };

  function digit(c, ch, x, y, w, h, t) {
    var m = SEG[ch], out = "", mid = (h - t) / 2;
    function on(s) { return m.indexOf(s) !== -1; }
    if (on("a")) { out += sh(c, rectD(x, y, w, t), "main"); }
    if (on("g")) { out += sh(c, rectD(x, y + mid, w, t), "main"); }
    if (on("d")) { out += sh(c, rectD(x, y + h - t, w, t), "main"); }
    [["f", "e", x], ["b", "c", x + w - t]].forEach(function (side) {
      var up = on(side[0]), low = on(side[1]), sx = side[2];
      var top = on("a") ? y + t - 0.3 : y;
      var bot = on("d") ? y + h - t + 0.3 : y + h;
      if (up && low && !on("g")) {
        out += sh(c, rectD(sx, top, t, bot - top), "main");
        return;
      }
      if (up) {
        var end = on("g") ? y + mid + 0.3 : y + mid + t;
        out += sh(c, rectD(sx, top, t, end - top), "main");
      }
      if (low) {
        var start = on("g") ? y + mid + t - 0.3 : y + mid;
        out += sh(c, rectD(sx, start, t, bot - start), "main");
      }
    });
    return out;
  }

  var EMBLEM = {
    session_winner: function (c) {
      if (c.step < 4 || c.locked) {
        return sh(c, rectD(5, 2, 3, 36), "accent") + flagCells(c, 8, 3, 5, 4, 5, 0, "main");
      }
      var u = sh(c, rectD(18.8, 3, 2.4, 36), "accent") + flagCells(c, 21, 3, 4, 3, 3.5, 1, "main");
      return '<g transform="rotate(16 20 21)">' + u + '</g><g transform="translate(40 0) scale(-1 1) rotate(16 20 21)">' + u + "</g>";
    },

    weekend_double: function (c) {
      var d = polyD(ONE);
      var back = '<g transform="translate(15.5 0)">' + sh(c, d, "accent") + "</g>";
      var front = '<g transform="translate(6.5 5)">' +
        (c.locked ? "" : '<path d="' + d + '" fill="' + col(c, "dark") + '" stroke="' + col(c, "dark") + '" stroke-width="3"/>') +
        sh(c, d, "main") + "</g>";
      return back + front;
    },

    perfect_order: function (c) {
      var out = sh(c, rectD(2, 1, 1.4, 38), "main") + sh(c, rectD(36.6, 1, 1.4, 38), "main");
      for (var i = 0; i < 4; i++) {
        var y = 3 + i * 8.8;
        out += sh(c, rectD(7, y, 12, 6), i === 0 ? "accent" : "main");
        out += sh(c, rectD(21, y + 4.4, 12, 6), "main");
      }
      return out;
    },

    sharp_eye: function (c) {
      var out = "";
      function bracket(x, y, sx, sy) {
        var p = [[0, 0], [9, 0], [9, 2.5], [2.5, 2.5], [2.5, 9], [0, 9]].map(function (q) { return [x + q[0] * sx, y + q[1] * sy]; });
        return sh(c, polyD(p), "main");
      }
      out += bracket(4, 2, 1, 1) + bracket(36, 2, -1, 1) + bracket(4, 26, 1, -1) + bracket(36, 26, -1, -1);
      out += sh(c, circleD(20, 14, 3.5), "accent");
      if (c.step >= 2) { out += sh(c, ringD(20, 14, 8, 1.2), "main"); }
      for (var i = 0; i < 4; i++) { out += sh(c, rectD(2.5 + i * 10, 31, 5, 6), i % 2 === 0 ? "red" : "main"); }
      return out;
    },

    fastest_lap_caller: function (c) {
      var cx = 20, cy = 25, out = "";
      for (var i = 0; i < 9; i++) {
        var a = 210 - i * 30;
        var p1 = pt(cx, cy, 11, a), p2 = pt(cx, cy, 17, a);
        out += sh(c, barD(p1[0], p1[1], p2[0], p2[1], 2.6), i >= 7 ? "red" : "main");
      }
      if (c.step >= 2) { out += sh(c, sectorD(cx, cy, 19.2, 20.2, 210, -30), "main"); }
      var tip = pt(cx, cy, 13.5, 62);
      out += sh(c, barD(cx, cy, tip[0], tip[1], 2.6), "accent");
      out += sh(c, circleD(cx, cy, 3.2), "accent");
      return out;
    },

    dnf_oracle: function (c) {
      var out = sh(c, ringD(20, 20, 16, 3.5), "main") + sh(c, ringD(20, 20, 9.5, 1.3), "main");
      for (var i = 0; i < 5; i++) {
        var p = pt(20, 20, 5.2, 90 + i * 72);
        out += sh(c, circleD(p[0], p[1], 1.6), "main");
      }
      out += sh(c, circleD(20, 20, 1.2), "accent");
      out += sh(c, barD(4, 35, 36, 5, 7), "dark");
      out += sh(c, barD(4, 35, 36, 5, 3.2), "red");
      return out;
    },

    big_weekend: function (c) {
      var out = "";
      out += sh(c, polyD([[3, 20], [10.5, 20], [13.5, 23], [13.5, 34], [3, 34]]), "main");
      out += sh(c, polyD([[14.5, 8], [22.5, 8], [25.5, 11], [25.5, 34], [14.5, 34]]), "main");
      out += sh(c, polyD([[26.5, 25], [34, 25], [37, 28], [37, 34], [26.5, 34]]), "main");
      out += sh(c, rectD(14.5, 8, 8, 3), "accent");
      for (var i = 0; i < 10; i += 2) { out += sh(c, rectD(i * 4, 36, 4, 4), "main"); }
      return out;
    },

    season_points: function (c) {
      var filled = [6, 12, 18, 24][c.locked ? 0 : c.step - 1], out = "";
      for (var i = 0; i < 24; i++) {
        var a1 = 90 - i * 15 - 1.25;
        out += sh(c, sectorD(20, 20, 12.5, 18, a1, a1 - 12.5), i < filled ? "main" : "dim");
      }
      out += sh(c, rectD(15.75, 15.75, 4.5, 4.5), "accent") + sh(c, rectD(20.25, 20.25, 4.5, 4.5), "accent");
      return out;
    },

    regular: function (c) {
      var text = ["10", "30", "60", "120"][c.locked ? 0 : c.step - 1], out = "";
      var three = text.length === 3;
      var w = three ? 10.5 : 14, t = three ? 3 : 3.6, gapX = three ? 3 : 4;
      var total = text.length * w + (text.length - 1) * gapX;
      var x0 = (40 - total) / 2;
      for (var i = 0; i < text.length; i++) { out += digit(c, text.charAt(i), x0 + i * (w + gapX), 5, w, 26, t); }
      out += sh(c, rectD(4, 34, 32, 2.4), "accent");
      return out;
    },

    ever_present: function (c) {
      var out = ln(c, "M6 31V13Q6 7 12 7H30Q35 7 35 12Q35 17 30 17H21Q17 17 17 21Q17 25 21 25H32Q37 25 37 30Q37 34 33 34H10Q6 34 6 31Z", "main", 3.4);
      out += sh(c, barD(24, 30, 24, 38, 2.6), "accent");
      return out;
    },

    leader: function (c) {
      var out = sh(c, rectD(0, 2, 1.6, 34), "main");
      out += sh(c, polyD([[3, 4], [38, 4], [33.5, 12.5], [3, 12.5]]), "accent");
      out += sh(c, polyD([[3, 15], [30, 15], [25.5, 23.5], [3, 23.5]]), "main");
      out += sh(c, polyD([[3, 26], [22, 26], [17.5, 34.5], [3, 34.5]]), "main");
      return out;
    },

    comeback: function (c) {
      var d = "M2 18L20 2L38 18V24L20 8L2 24Z";
      return sh(c, d, "accent") + '<g transform="translate(0 12)">' + sh(c, d, "main") + "</g>";
    },

    title_caller: function (c) {
      // A pit-board 1 inside two branches of angled leaves. More leaves at each step.
      var n = [4, 4, 5, 6][c.locked ? 0 : c.step - 1], out = "";
      function leaf(angle, tilt) {
        var p = pt(20, 21, 15.5, angle);
        var t = rad(angle + 90 + tilt);
        var dx = Math.cos(t) * 3.7, dy = -Math.sin(t) * 3.7;
        return sh(c, barD(p[0] - dx, p[1] - dy, p[0] + dx, p[1] + dy, 2.8), "main");
      }
      for (var k = 0; k < n; k++) {
        var a = 252 - k * (112 / (n - 1));
        out += leaf(a, 32) + leaf(180 - a, -32);
      }
      out += '<g transform="translate(13.3 8.5) scale(0.72)">' + sh(c, polyD(ONE), "accent") + "</g>";
      return out;
    },

    sharp_shooter: function (c) {
      var out = "";
      out += sh(c, octD(20, 20, 36, 8) + octD(20, 20, 30, 6.5), "main");
      out += sh(c, octD(20, 20, 24, 5.5) + octD(20, 20, 18, 4), "main");
      out += sh(c, octD(20, 20, 10, 3), "accent");
      return out;
    }
  };

  // ---------- Plate and badge ----------

  var PLATE = "M14 2H62V58L50 70H2V14Z";
  var KEY = "M15.7 6H58V56.3L48.3 66H6V15.7Z";

  function plate(c) {
    var s = c.step, out = "";
    if (c.locked) { return '<path d="' + PLATE + '" fill="none" stroke="' + C.line + '" stroke-width="1.5"/>'; }
    var edge = s === 4 ? C.yellow : C.white;
    if (s === 4) { out += '<rect x="0" y="31" width="4" height="10" fill="' + C.yellow + '"/><rect x="60" y="31" width="4" height="10" fill="' + C.yellow + '"/>'; }
    out += '<path d="' + PLATE + '" fill="' + (s === 4 ? C.ink : C.plate) + '"/>';
    if (s === 3) {
      out += '<path d="M14 2H62V11H5Z" fill="' + C.yellow + '"/>';
      for (var r = 0; r < 2; r++) {
        for (var k = 0; k < 3; k++) {
          if ((r + k) % 2 === 0) { out += '<rect x="' + (48.5 + k * 4.5) + '" y="' + (2 + r * 4.5) + '" width="4.5" height="4.5" fill="' + C.ink + '"/>'; }
        }
      }
    }
    if (s === 4) {
      for (var i = 0; i < 5; i++) { out += '<rect x="' + (17 + i * 7) + '" y="6.5" width="4.5" height="4.5" fill="' + C.red + '"/>'; }
    }
    out += '<path d="' + PLATE + '" fill="none" stroke="' + edge + '" stroke-width="' + (s === 4 ? 2 : 1.5) + '"/>';
    if (s >= 2) { out += '<path d="' + KEY + '" fill="none" stroke="' + edge + '" stroke-width="' + (s === 4 ? 1 : 0.75) + '"/>'; }
    if (s === 2 || s === 3) {
      out += '<rect x="55" y="6" width="3" height="3" fill="' + C.white + '"/><rect x="6" y="63" width="3" height="3" fill="' + C.white + '"/>';
    }
    // Step marks: one small square for each step reached.
    var total = s * 3 + (s - 1) * 2, x = 32 - total / 2;
    for (var j = 0; j < s; j++) { out += '<rect x="' + (x + j * 5) + '" y="61.5" width="3" height="3" fill="' + (s === 4 ? C.yellow : C.white) + '"/>'; }
    return out;
  }

  function badgeSvg(key, step, locked, size) {
    var emblem = EMBLEM[key];
    if (!emblem) { return ""; }
    var s = Math.max(1, Math.min(4, step | 0 || 1));
    var c = { step: locked ? 1 : s, locked: !!locked };
    var w = size || 64;
    var def = BY_KEY[key];
    var label = (def ? def.name : key) + (locked ? ", locked" : ", step " + STEP_LABEL[s - 1]);
    return '<svg class="ach-badge" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 72" width="' + w + '" height="' + Math.round(w * 72 / 64) +
      '" role="img" aria-label="' + label + '">' + plate(c) + '<g transform="translate(11 19)">' + emblem(c) + "</g></svg>";
  }

  // ---------- Definitions (order matches the database view) ----------
  // tiers: [target, badge step] for each level.

  var DEFS = [
    { key: "session_winner", name: "Session Winner", text: "Win a session. Top score with at least two players scoring; ties share the win.", unit: "wins",
      tiers: [[1, 1], [5, 2], [15, 3], [40, 4]] },
    { key: "weekend_double", name: "Weekend Double", text: "Win both qualifying and the race of the same weekend.", unit: "weekends",
      tiers: [[1, 2], [3, 3], [8, 4]] },
    { key: "perfect_order", name: "Perfect Order", text: "Every slot exactly right: 8 in a race or sprint top 8, 10 in a Q3 order.", unit: "perfect orders",
      tiers: [[1, 3], [3, 4]] },
    { key: "sharp_eye", name: "Sharp Eye", text: "Most exact positions in one race or sprint top 8.", unit: "exact positions",
      tiers: [[3, 2], [5, 3], [7, 4]] },
    { key: "fastest_lap_caller", name: "Fastest Lap Caller", text: "Call the fastest lap of a race.", unit: "fastest laps",
      tiers: [[1, 1], [5, 2], [10, 3], [20, 4]] },
    { key: "dnf_oracle", name: "DNF Oracle", text: "Points from your DNF driver picks in a single race.", unit: "points",
      tiers: [[8, 2], [16, 3], [24, 4]] },
    { key: "big_weekend", name: "Big Weekend", text: "Qualifying plus race points in a single weekend.", unit: "points",
      tiers: [[50, 2], [80, 3], [110, 4]] },
    { key: "season_points", name: "Season Points", text: "Points in one season.", unit: "points",
      tiers: [[250, 1], [500, 2], [1000, 3], [1500, 4]] },
    { key: "regular", name: "Regular", text: "Sessions scored, all seasons.", unit: "sessions",
      tiers: [[10, 1], [30, 2], [60, 3], [120, 4]] },
    { key: "ever_present", name: "Ever-present", text: "Longest run of consecutive approved sessions you scored in, within one season.", unit: "sessions in a row",
      tiers: [[10, 2], [20, 3], [40, 4]] },
    { key: "leader", name: "Leader", text: "Rounds spent first in the standings.", unit: "rounds",
      tiers: [[1, 2], [5, 3], [12, 4]] },
    { key: "comeback", name: "Comeback", text: "Rounds where you gained two or more places in the standings.", unit: "rounds",
      tiers: [[1, 2], [3, 3], [6, 4]] },
    { key: "sharp_shooter", name: "Sharp Shooter", text: "Sessions with at least 85% of your predicted slots right.", unit: "sessions",
      tiers: [[1, 2], [5, 3], [15, 4]] },
    { key: "title_caller", name: "Title Caller", text: "Your Drivers' or Constructors' champion pick finished 1st. Each correct call counts once; calls add up over seasons.", unit: "champions called",
      tiers: [[1, 2], [2, 3], [4, 4]] }
  ];

  var BY_KEY = {};
  DEFS.forEach(function (d) { BY_KEY[d.key] = d; });

  root.LO_ACH = { DEFS: DEFS, BY_KEY: BY_KEY, STEP_LABEL: STEP_LABEL, badgeSvg: badgeSvg, COLORS: C };
  if (typeof module !== "undefined" && module.exports) { module.exports = root.LO_ACH; }
})(typeof window !== "undefined" ? window : this);