// Lights Out: shared profile logic. Levels, ranks, avatars and rank badges.
// Used by the Account page and the home standings. No network calls in this file.
(function () {
  "use strict";

  // ---------- Levels ----------
  // XP is the player's lifetime points. Level n needs 40 * (n - 1)^1.6 XP in total.
  var LEVEL_CAP = 50;

  function xpForLevel(n) {
    return n <= 1 ? 0 : Math.round(40 * Math.pow(n - 1, 1.6));
  }

  function levelFor(xp) {
    var total = Math.max(0, Math.floor(Number(xp) || 0));
    var level = 1;
    while (level < LEVEL_CAP && total >= xpForLevel(level + 1)) { level++; }
    var floor = xpForLevel(level);
    var ceil = level >= LEVEL_CAP ? floor : xpForLevel(level + 1);
    var span = Math.max(1, ceil - floor);
    return {
      xp: total,
      level: level,
      floor: floor,
      ceil: ceil,
      into: total - floor,
      toNext: level >= LEVEL_CAP ? 0 : ceil - total,
      progress: level >= LEVEL_CAP ? 1 : (total - floor) / span,
      maxed: level >= LEVEL_CAP
    };
  }

  // ---------- Ranks ----------
  var RANKS = [
    { name: "Rookie", from: 1 },
    { name: "Midfielder", from: 4 },
    { name: "Points Finisher", from: 8 },
    { name: "Podium Regular", from: 12 },
    { name: "Race Winner", from: 18 },
    { name: "Champion", from: 25 },
    { name: "Legend", from: 35 }
  ];

  function tierFor(level) {
    var tier = 0;
    for (var i = 0; i < RANKS.length; i++) { if (level >= RANKS[i].from) { tier = i; } }
    return tier;
  }

  function rankFor(level) {
    var tier = tierFor(level);
    var next = RANKS[tier + 1] || null;
    return { tier: tier, name: RANKS[tier].name, nextName: next ? next.name : null, nextFrom: next ? next.from : null };
  }

  // ---------- Rank badge (viewBox 48 x 56) ----------
  var YELLOW = "#ffd400", INK = "#0d0e10", WHITE = "#f3f3f0", RED = "#e0262c", PLATE = "#1b1e24";
  var SHIELD = "M5 3 H43 V36 L24 53 L5 36 Z";
  var INNER = "M9 7 H39 V34 L24 47 L9 34 Z";

  function chevrons(count, colour, top) {
    var out = "";
    for (var i = 0; i < count; i++) {
      var y = top + i * 7;
      out += '<path d="M14 ' + y + ' L24 ' + (y + 7) + ' L34 ' + y + '" fill="none" stroke="' + colour +
        '" stroke-width="3" stroke-linejoin="miter"/>';
    }
    return out;
  }

  function checker(x, y, cols, rows, size, colour) {
    var out = "";
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if ((r + c) % 2 === 0) {
          out += '<rect x="' + (x + c * size) + '" y="' + (y + r * size) + '" width="' + size + '" height="' + size + '" fill="' + colour + '"/>';
        }
      }
    }
    return out;
  }

  function badgeSvg(tier, size) {
    var t = Math.max(0, Math.min(RANKS.length - 1, tier | 0));
    var g = "";
    if (t === 0) {
      g = '<path d="' + SHIELD + '" fill="' + PLATE + '" stroke="#5a606a" stroke-width="2"/>' + chevrons(1, "#8f98a3", 21);
    } else if (t === 1) {
      g = '<path d="' + SHIELD + '" fill="' + PLATE + '" stroke="#8f98a3" stroke-width="2"/>' + chevrons(2, "#c9ccd1", 18);
    } else if (t === 2) {
      g = '<path d="' + SHIELD + '" fill="' + PLATE + '" stroke="' + WHITE + '" stroke-width="2"/>' +
        '<rect x="5" y="3" width="5" height="5" fill="' + WHITE + '"/><rect x="38" y="3" width="5" height="5" fill="' + WHITE + '"/>' +
        chevrons(3, WHITE, 15);
    } else if (t === 3) {
      g = '<path d="' + SHIELD + '" fill="' + PLATE + '" stroke="' + WHITE + '" stroke-width="2"/>' +
        '<rect x="5" y="3" width="38" height="8" fill="' + YELLOW + '"/>' + chevrons(3, WHITE, 17);
    } else if (t === 4) {
      g = '<path d="' + SHIELD + '" fill="' + YELLOW + '" stroke="' + YELLOW + '" stroke-width="2"/>' +
        checker(7, 5, 9, 2, 4, INK) + chevrons(3, INK, 17);
    } else if (t === 5) {
      g = '<path d="' + SHIELD + '" fill="' + YELLOW + '" stroke="' + YELLOW + '" stroke-width="2"/>' +
        '<path d="' + INNER + '" fill="none" stroke="' + INK + '" stroke-width="1.5"/>' +
        checker(12, 10, 6, 2, 4, INK) + chevrons(3, INK, 21);
    } else {
      var lights = "";
      for (var i = 0; i < 5; i++) { lights += '<rect x="' + (10 + i * 6.6) + '" y="8" width="4.6" height="4.6" fill="' + RED + '"/>'; }
      g = '<path d="' + SHIELD + '" fill="' + INK + '" stroke="' + YELLOW + '" stroke-width="2.5"/>' +
        '<path d="' + INNER + '" fill="none" stroke="' + YELLOW + '" stroke-width="1"/>' + lights + chevrons(3, YELLOW, 20);
    }
    var w = size || 48;
    return '<svg class="rank-badge" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 56" width="' + w + '" height="' +
      Math.round(w * 56 / 48) + '" role="img" aria-label="' + RANKS[t].name + ' rank">' + g + "</svg>";
  }

  // ---------- Avatar (helmet on a tile, viewBox 64 x 64) ----------
  var PATTERNS = ["Solid", "Stripe", "Twin stripe", "Chevron", "Split", "Diagonal", "Dots", "Checker", "Block", "Cap", "Ring", "Zigzag"];
  var COLOURS = [
    { name: "Yellow", hex: "#ffd400" }, { name: "White", hex: "#f3f3f0" },
    { name: "Steel", hex: "#8f98a3" }, { name: "Sand", hex: "#c9a26b" },
    { name: "Sage", hex: "#7fa383" }, { name: "Sky", hex: "#7e95b5" },
    { name: "Plum", hex: "#a07fb0" }, { name: "Rose", hex: "#c28d8d" }
  ];

  var BODY = "M9 40 C9 22 21 11 35 11 C49 11 57 22 57 35 L57 45 C57 49 54 52 50 52 L18 52 C12 52 9 47 9 40 Z";
  var VISOR = "M33 27 L57 29 L57 41 L29 41 C27 35 29 30 33 27 Z";

  function patternShapes(p, c) {
    switch (p) {
      case 0: return '<rect width="64" height="64" fill="' + c + '"/>';
      case 1: return '<path d="M12 30 Q30 2 58 22 L58 32 Q32 12 12 40 Z" fill="' + c + '"/>';
      case 2: return '<path d="M12 27 Q30 0 58 18 L58 24 Q32 6 12 33 Z" fill="' + c + '"/><path d="M12 38 Q30 11 58 29 L58 35 Q32 17 12 44 Z" fill="' + c + '"/>';
      case 3: return '<path d="M9 23 L29 38 L9 53 L9 44 L18 38 L9 32 Z" fill="' + c + '"/>';
      case 4: return '<rect x="0" y="0" width="64" height="31" fill="' + c + '"/>';
      case 5: return '<path d="M0 54 L38 8 L50 8 L12 54 Z" fill="' + c + '"/>';
      case 6: return [[15, 30], [23, 25], [15, 40], [23, 36], [15, 20], [23, 46]].map(function (d) {
        return '<circle cx="' + d[0] + '" cy="' + d[1] + '" r="3.2" fill="' + c + '"/>'; }).join("");
      case 7: return checker(9, 20, 4, 6, 6, c);
      case 8: return '<rect x="0" y="0" width="26" height="64" fill="' + c + '"/>';
      case 9: return '<path d="M0 0 H64 V25 Q36 15 0 31 Z" fill="' + c + '"/>';
      case 10: return '<circle cx="20" cy="36" r="9" fill="none" stroke="' + c + '" stroke-width="3.5"/><circle cx="20" cy="36" r="3" fill="' + c + '"/>';
      default: return '<path d="M8 47 L15 40 L22 47 L29 40 L36 47 L43 40 L50 47 L58 41" fill="none" stroke="' + c + '" stroke-width="3.6"/>';
    }
  }

  var uid = 0;

  function parseAvatar(code) {
    var m = /^p(\d{1,2})-c(\d)-n(\d{1,2})$/.exec(String(code || ""));
    if (!m) { return null; }
    var p = parseInt(m[1], 10), c = parseInt(m[2], 10), n = parseInt(m[3], 10);
    if (p > 11 || c > 7 || n < 1 || n > 99) { return null; }
    return { pattern: p, colour: c, number: n };
  }

  function buildCode(a) { return "p" + a.pattern + "-c" + a.colour + "-n" + a.number; }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // A stable avatar for players who have not picked one yet.
  function defaultAvatar(userId) {
    var h = hash(String(userId || "player"));
    return { pattern: h % 12, colour: (h >> 4) % 8, number: ((h >> 8) % 99) + 1 };
  }

  function avatarSvg(source, size, userId) {
    var a = typeof source === "string" ? parseAvatar(source) : source;
    if (!a) { a = defaultAvatar(userId); }
    var id = "av" + (++uid);
    var accent = COLOURS[a.colour].hex;
    var w = size || 64;
    return '<svg class="avatar-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="' + w + '" height="' + w +
      '" role="img" aria-label="Helmet avatar">' +
      '<defs><clipPath id="' + id + '"><path d="' + BODY + '"/></clipPath></defs>' +
      '<rect width="64" height="64" fill="#15181d"/>' +
      '<g transform="translate(-7.6 -9)  scale(1.2)">' +
      '<path d="' + BODY + '" fill="#262a31"/>' +
      '<g clip-path="url(#' + id + ')">' + patternShapes(a.pattern, accent) + "</g>" +
      '<path d="' + VISOR + '" fill="#0a0b0d" stroke="#3a3f46" stroke-width="1"/>' +
      '<path d="M36 30 L52 31.5" stroke="#4d535b" stroke-width="1.5" fill="none"/></g>' +
      '<text x="60" y="61.5" text-anchor="end" class="av-num" fill="' + accent + '">' + a.number + "</text></svg>";
  }

  window.LO_PROFILE = {
    LEVEL_CAP: LEVEL_CAP, RANKS: RANKS, PATTERNS: PATTERNS, COLOURS: COLOURS,
    xpForLevel: xpForLevel, levelFor: levelFor, tierFor: tierFor, rankFor: rankFor,
    badgeSvg: badgeSvg, avatarSvg: avatarSvg, parseAvatar: parseAvatar,
    buildCode: buildCode, defaultAvatar: defaultAvatar
  };
})();
