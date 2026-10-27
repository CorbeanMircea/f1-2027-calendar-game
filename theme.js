// Lights Out: data-driven Grand Prix themes.
// Everything here is derived from the event record (id, locality, country).
// No race is hardcoded into the homepage. To give a race real artwork, drop files in:
//   assets/hero/<stem>.jpg       (photo, shown in monochrome behind the hero)
//   assets/circuits/<stem>.svg   (real circuit outline: one <path> and a viewBox)
// <stem> is the event id without the year, for example monaco, japan, mexico-city.
(function () {
  "use strict";

  // stem -> [environment motif, atmosphere tint]
  var RACES = {
    "bahrain": ["desert", "#c9a26b"],
    "saudi-arabia": ["coast", "#6f93a3"],
    "australia": ["hills", "#7fa383"],
    "japan": ["mountain", "#b98b92"],
    "china": ["skyline", "#8f9aa8"],
    "miami": ["coast", "#6fb0b0"],
    "canada": ["skyline", "#8396ad"],
    "monaco": ["harbour", "#c28d6b"],
    "portugal": ["hills", "#b79a6b"],
    "great-britain": ["grandstand", "#8c9a8e"],
    "austria": ["mountain", "#7f9f86"],
    "belgium": ["pines", "#6f8f7a"],
    "hungary": ["hills", "#b8a066"],
    "italy": ["pines", "#a3a07a"],
    "spain": ["skyline", "#c0916e"],
    "azerbaijan": ["skyline", "#7e95b5"],
    "turkey": ["skyline", "#a08f7e"],
    "singapore": ["skyline", "#7aa0a6"],
    "united-states": ["skyline", "#a98a7a"],
    "mexico": ["stadium", "#6f9f78"],
    "mexico-city": ["stadium", "#6f9f78"],
    "brazil": ["hills", "#78a07e"],
    "las-vegas": ["skyline", "#a07fb0"],
    "qatar": ["desert", "#c4a37a"],
    "abu-dhabi": ["skyline", "#c2a070"]
  };
  var FALLBACK = ["grandstand", "#8a8f98"];

  // Event stems that share artwork with another stem (2027 "mexico" uses the Mexico City files).
  var ASSET_ALIAS = { "mexico": "mexico-city" };

  function stemOf(ev) {
    return String(ev.id || ev.name || "race").toLowerCase().replace(/-\d{4}$/, "");
  }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function n(v) { return v.toFixed(1); }

  // ---------- Environment silhouettes (viewBox 0 0 1440 320, ground line at y = 300) ----------

  var GROUND = 300;

  function rect(cls, x, y, w, h) {
    return '<rect class="' + cls + '" x="' + n(x) + '" y="' + n(y) + '" width="' + n(w) + '" height="' + n(h) + '"/>';
  }

  function mast(x, h) {
    return rect("m1", x, GROUND - h, 5, h) + rect("m1", x - 16, GROUND - h - 9, 37, 11);
  }

  function skyline(r) {
    var out = "";
    [["m2", 30, 120, 26, 58], ["m1", 40, 180, 34, 78]].forEach(function (layer) {
      var x = -10;
      while (x < 1450) {
        var w = layer[3] + r() * (layer[4] - layer[3]);
        var h = layer[1] + r() * (layer[2] - layer[1]);
        out += rect(layer[0], x, GROUND - h, w, h);
        if (r() > 0.78) { out += rect(layer[0], x + w / 2 - 1.5, GROUND - h - 26, 3, 26); }
        x += w + r() * 5;
      }
    });
    return out;
  }

  function dunes(r) {
    var out = "";
    [["m2", 230, 275], ["m1", 258, 290]].forEach(function (layer) {
      var d = "M-10 " + GROUND + " L-10 " + n(layer[1] + r() * 20);
      for (var x = 150; x <= 1600; x += 160) {
        d += " Q " + n(x - 80) + " " + n(layer[1] - 30 + r() * 40) + " " + n(x) + " " + n(layer[1] + r() * 24);
      }
      out += '<path class="' + layer[0] + '" d="' + d + ' L1450 ' + GROUND + ' Z"/>';
    });
    return out + mast(200, 120) + mast(1180, 150) + mast(1330, 100);
  }

  function hills(r) {
    var out = "";
    [["m2", 190, 250], ["m1", 235, 285]].forEach(function (layer) {
      var d = "M-10 " + GROUND + " L-10 " + n(layer[1]);
      for (var x = 200; x <= 1650; x += 200) {
        d += " Q " + n(x - 100) + " " + n(layer[1] - 60 - r() * 40) + " " + n(x) + " " + n(layer[1] + r() * 30);
      }
      out += '<path class="' + layer[0] + '" d="' + d + ' L1450 ' + GROUND + ' Z"/>';
    });
    return out;
  }

  function mountain(r) {
    var out = "";
    [["m2", 110, 230, 150], ["m1", 50, 150, 110]].forEach(function (layer) {
      var d = "M-10 " + GROUND;
      var x = -10;
      while (x < 1460) {
        var step = layer[3] + r() * 90;
        d += " L" + n(x + step / 2) + " " + n(GROUND - layer[1] - r() * (layer[2] - layer[1])) + " L" + n(x + step) + " " + n(GROUND - 20 - r() * 20);
        x += step;
      }
      out += '<path class="' + layer[0] + '" d="' + d + ' L1460 ' + GROUND + ' Z"/>';
    });
    return out;
  }

  function pines(r) {
    var out = "";
    [["m2", 50, 100, 20], ["m1", 70, 140, 26]].forEach(function (layer) {
      for (var x = -10; x < 1450; x += layer[3] * (0.8 + r() * 0.5)) {
        var h = layer[1] + r() * (layer[2] - layer[1]);
        var w = layer[3];
        out += '<path class="' + layer[0] + '" d="M' + n(x) + ' ' + GROUND + ' L' + n(x + w / 2) + ' ' + n(GROUND - h) + ' L' + n(x + w) + ' ' + GROUND + ' Z"/>';
      }
    });
    return out;
  }

  function stadium() {
    var out = '<path class="m2" d="M120 300 Q720 -20 1320 300 Z"/>';
    out += '<path class="m1" d="M250 300 Q720 90 1190 300 Z"/>';
    out += '<g fill="none" stroke="#262a31" stroke-width="2">';
    for (var i = 0; i < 4; i++) {
      var k = 28 + i * 26;
      out += '<path d="M' + (250 + k) + ' 300 Q720 ' + (130 + i * 34) + ' ' + (1190 - k) + ' 300"/>';
    }
    out += "</g>";
    return out + mast(90, 170) + mast(1350, 170) + mast(470, 120) + mast(970, 120);
  }

  function grandstand(r) {
    var out = "";
    for (var i = 0; i < 6; i++) {
      out += rect(i % 2 ? "m1" : "m2", 300 + i * 18, GROUND - 28 - i * 22, 840 - i * 36, 24);
    }
    out += rect("m1", 270, GROUND - 190, 900, 8) + rect("m1", 300, GROUND - 190, 6, 160) + rect("m1", 1134, GROUND - 190, 6, 160);
    return out + mast(110, 140 + r() * 30) + mast(1330, 140 + r() * 30);
  }

  function coast(r) {
    var out = rect("m2", -10, 266, 1460, 34);
    for (var i = 0; i < 7; i++) {
      var x = 90 + i * 215 + r() * 60;
      var h = 90 + r() * 70;
      var lean = (r() - 0.5) * 36;
      var tx = x + lean;
      var ty = GROUND - h;
      out += '<path class="ms" d="M' + n(x) + ' ' + GROUND + ' Q' + n(x + lean * 0.2) + ' ' + n(GROUND - h * 0.6) + ' ' + n(tx) + ' ' + n(ty) + '"/>';
      for (var f = 0; f < 5; f++) {
        var a = (-0.9 + f * 0.45) * Math.PI / 1.3 - Math.PI / 2;
        out += '<path class="ms" d="M' + n(tx) + ' ' + n(ty) + ' q' + n(Math.cos(a) * 24) + ' ' + n(Math.sin(a) * 18 - 6) + ' ' + n(Math.cos(a) * 46) + ' ' + n(Math.sin(a) * 26 + 14) + '"/>';
      }
    }
    return out;
  }

  function harbour(r) {
    var d = "M-10 " + GROUND + " L-10 150";
    for (var x = 60; x <= 700; x += 70) { d += " L" + x + " " + n(150 - x * 0.12 + r() * 14) + " L" + (x + 35) + " " + n(150 - x * 0.12 + r() * 14 + 10); }
    d += " L760 " + GROUND + " Z";
    var out = '<path class="m2" d="' + d + '"/>';
    for (var b = 0; b < 16; b++) {
      var bx = 20 + (b % 8) * 80 + r() * 20;
      var by = 120 + Math.floor(b / 8) * 60 + r() * 30;
      out += rect("m1", bx, by, 26 + r() * 26, 36 + r() * 30);
    }
    out += rect("m1", 700, 270, 760, 30);
    for (var i = 0; i < 8; i++) {
      var sx = 780 + i * 80 + r() * 30;
      var h = 40 + r() * 50;
      out += '<path class="m1" d="M' + n(sx) + ' 270 L' + n(sx + 46) + ' 270 L' + n(sx + 38) + ' 282 L' + n(sx + 6) + ' 282 Z"/>';
      out += rect("m1", sx + 22, 270 - h, 2.5, h) + '<path class="m1" d="M' + n(sx + 26) + ' ' + n(270 - h + 6) + ' L' + n(sx + 26) + ' 266 L' + n(sx + 50) + ' 266 Z"/>';
    }
    return out;
  }

  var MOTIFS = {
    skyline: skyline, desert: dunes, hills: hills, mountain: mountain, pines: pines,
    stadium: stadium, grandstand: grandstand, coast: coast, harbour: harbour
  };

  // ---------- Generated racing line (fallback when no real outline is supplied) ----------

  function racingLine(seed) {
    var r = rng(seed);
    var count = 12;
    var pts = [];
    for (var i = 0; i < count; i++) {
      var a = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.3;
      var rad = i % 2 ? 0.42 + r() * 0.22 : 0.78 + r() * 0.24;
      pts.push([300 + Math.cos(a) * rad * 270, 190 + Math.sin(a) * rad * 150]);
    }
    var d = "M" + n(pts[0][0]) + " " + n(pts[0][1]);
    for (var j = 0; j < count; j++) {
      var p0 = pts[(j + count - 1) % count], p1 = pts[j], p2 = pts[(j + 1) % count], p3 = pts[(j + 2) % count];
      d += " C" + n(p1[0] + (p2[0] - p0[0]) / 6) + " " + n(p1[1] + (p2[1] - p0[1]) / 6) + " " +
           n(p2[0] - (p3[0] - p1[0]) / 6) + " " + n(p2[1] - (p3[1] - p1[1]) / 6) + " " + n(p2[0]) + " " + n(p2[1]);
    }
    var dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    return {
      viewBox: "0 0 600 380",
      d: d + " Z",
      generated: true,
      start: { x1: pts[0][0] + (dy / len) * 14, y1: pts[0][1] - (dx / len) * 14, x2: pts[0][0] - (dy / len) * 14, y2: pts[0][1] + (dx / len) * 14 }
    };
  }

  // ---------- Public API ----------

  function forEvent(ev) {
    var stem = stemOf(ev);
    var info = RACES[stem] || FALLBACK;
    var seed = hash(stem);
    var draw = MOTIFS[info[0]] || MOTIFS.grandstand;
    return { stem: stem, assetStem: ASSET_ALIAS[stem] || stem, motifName: info[0], atmos: info[1], motif: draw(rng(seed ^ 0x9e3779b9)), line: racingLine(seed) };
  }

  function loadPhoto(stem) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img.src); };
      img.onerror = function () { resolve(null); };
      img.src = "assets/hero/" + stem + ".jpg";
    });
  }

  function loadCircuit(stem) {
    if (!window.fetch || !window.DOMParser) { return Promise.resolve(null); }
    return window.fetch("assets/circuits/" + stem + ".svg").then(function (res) {
      return res.ok ? res.text() : null;
    }).then(function (text) {
      if (!text) { return null; }
      var doc = new DOMParser().parseFromString(text, "image/svg+xml");
      var svg = doc.querySelector("svg");
      var paths = doc.querySelectorAll("path");
      if (!svg || paths.length === 0 || !svg.getAttribute("viewBox")) { return null; }
      var best = paths[0];
      for (var i = 1; i < paths.length; i++) {
        if ((paths[i].getAttribute("d") || "").length > (best.getAttribute("d") || "").length) { best = paths[i]; }
      }
      return { viewBox: svg.getAttribute("viewBox"), d: best.getAttribute("d"), generated: false, start: null };
    }).catch(function () { return null; });
  }

  window.LO_THEME = { forEvent: forEvent, loadPhoto: loadPhoto, loadCircuit: loadCircuit };
})();