// Lights Out: applies the small page edits that go with migration 039 (late Race and Sprint predictions).
//
//   node tools/apply-late-entry-edits.mjs --check    only checks that every edit can be made (changes nothing)
//   node tools/apply-late-entry-edits.mjs            makes the edits
//
// Run it from the project root. It is all-or-nothing: if any text it needs to find is missing or not unique (for example because
// a file was changed by hand), it changes NOTHING and lists what it could not find. Running it twice is harmless.
import { readFile, writeFile } from "node:fs/promises";

const EDITS = [
  // ---- predict.html: the amber "late entry" light
  { file: "predict.html",
    find: '<link rel="stylesheet" href="predict-lights.css">',
    replace: '<link rel="stylesheet" href="predict-lights.css">\n  <link rel="stylesheet" href="late-entry.css">' },

  // ---- predict-lights.js: full value until Qualifying, late entry after it
  { file: "predict-lights.js",
    find: '.select("lock_at, is_open")',
    replace: '.select("lock_at, is_open, full_value_until, is_late")' },
  { file: "predict-lights.js",
    find: 'isOpen: row.is_open === true',
    replace: 'isOpen: row.is_open === true,\n          fullMs: row.full_value_until ? Date.parse(row.full_value_until) : null' },
  { file: "predict-lights.js",
    find: 'var hours = remaining / 3600000;',
    replace: 'var late = !!win.fullMs && now >= win.fullMs;\n    var fullRemaining = win.fullMs && !late ? win.fullMs - now : null;\n    var hours = (fullRemaining !== null ? fullRemaining : remaining) / 3600000;' },
  { file: "predict-lights.js",
    find: 'kind: remaining < 86400000 ? "soon" : "open",',
    replace: 'kind: late ? "late" : ((fullRemaining !== null ? fullRemaining : remaining) < 86400000 ? "soon" : "open"),' },
  { file: "predict-lights.js",
    find: 'text: remaining < 86400000 ? "Predictions lock soon" : "Predictions open",',
    replace: 'text: late ? "Late entry: counts at 70%" : (fullRemaining !== null ? (fullRemaining < 86400000 ? "Full value ends soon" : "Predictions open") : (remaining < 86400000 ? "Predictions lock soon" : "Predictions open")),' },
  { file: "predict-lights.js",
    find: 'time: "Locks in " + untilText(remaining),',
    replace: 'time: late ? "Closes in " + untilText(remaining) : (fullRemaining !== null ? "Full value for " + untilText(fullRemaining) + " \\u00b7 closes " + whenText(win.lockMs) : "Locks in " + untilText(remaining)),' },

  // ---- picks.js: every session reveals at its own start
  { file: "picks.js",
    find: 'var LOCK_TYPE = { qualifying: "qualifying", race: "qualifying", sprint_qualifying: "sprint_qualifying", sprint: "sprint_qualifying" };',
    replace: 'var LOCK_TYPE = { qualifying: "qualifying", race: "race", sprint_qualifying: "sprint_qualifying", sprint: "sprint" };' },

  // ---- home.js: the schedule list
  { file: "home.js",
    find: 'var lockType = LOCK_TYPE[session.session_type];',
    replace: 'var lockType = session.session_type; // every session now locks at its own start (migration 039)' },
  { file: "home.js",
    find: 'function lockTimeFor(session) {',
    replace: 'var EARLY_TYPE = { race: "qualifying", sprint: "sprint_qualifying" };\n\n  // Until when a Race or Sprint prediction has full value: the start of Qualifying / Sprint Qualifying (null for the others).\n  function fullValueFor(session) {\n    var early = EARLY_TYPE[session.session_type];\n    if (!early) { return null; }\n    for (var i = 0; i < current.sessions.length; i++) {\n      var s = current.sessions[i];\n      if (s.session_type === early && s.start_utc) { return msOf(s); }\n    }\n    return null;\n  }\n\n  function lockTimeFor(session) {' },
  { file: "home.js",
    find: 'state = lockMs !== null && lockMs - now < 86400000 ? "soon" : "open";',
    replace: 'var fullMs = fullValueFor(s);\n        state = fullMs !== null && fullMs <= now ? "soon" : (lockMs !== null && lockMs - now < 86400000 ? "soon" : "open");' },
  { file: "home.js",
    find: 'tag = state === "soon" ? "Closes soon" : "Open";',
    replace: 'tag = fullMs !== null && fullMs <= now ? "Late entry" : (state === "soon" ? "Closes soon" : "Open");' },
  { file: "home.js",
    find: 'note = LOCK_TYPE[s.session_type] === s.session_type',
    replace: 'note = fullMs !== null && fullMs <= now ? "Counts at 70% if saved or changed now" : fullMs !== null ? "Full value until " + TYPE_LABEL[EARLY_TYPE[s.session_type]] + " starts, then 70% until this session starts" : LOCK_TYPE[s.session_type] === s.session_type' },
  { file: "home.js",
    find: '"Predictions lock in"',
    replace: '"Full-value deadline in"' },
  { file: "home.js",
    find: '"All five lights on: predictions are locked."',
    replace: '"All five lights on: the full-value deadline has passed."' },

  // ---- scorecard.js: a late entry is recorded at 70% of the full-value score
  { file: "scorecard.js",
    find: 'var allSame = true;',
    replace: 'var allSame = true;\n    var recFull = recorded ? (recorded.breakdown && recorded.breakdown.late ? Number(recorded.breakdown.raw_total) : recorded.points) : null;' },
  { file: "scorecard.js",
    find: 'tot.appendChild(el("td", "", recorded ? String(recorded.points) : "\\u2014"));',
    replace: 'tot.appendChild(el("td", "", recorded ? String(recFull) : "\\u2014"));' },
  { file: "scorecard.js",
    find: 'var totalSame = !!recorded && recorded.points === calc.total;',
    replace: 'var totalSame = !!recorded && recFull === calc.total;' },
  { file: "scorecard.js",
    find: 'table.appendChild(tot);',
    replace: 'table.appendChild(tot);\n    if (recorded && recorded.breakdown && recorded.breakdown.late) {\n      var lateRow = document.createElement("tr");\n      var factor = Number(recorded.breakdown.late_factor);\n      var lateCalc = Math.floor(calc.total * factor);\n      lateRow.appendChild(el("td", "", "Late entry: saved after Qualifying started, counts at " + Math.round(factor * 100) + "% (rounded down)"));\n      lateRow.appendChild(el("td", "", String(lateCalc)));\n      lateRow.appendChild(el("td", "", String(recorded.points)));\n      var lateSame = lateCalc === recorded.points;\n      if (!lateSame) { allSame = false; }\n      lateRow.appendChild(el("td", lateSame ? "good" : "bad", lateSame ? "\\u2713" : "differs"));\n      table.appendChild(lateRow);\n    }' },
  { file: "scorecard.js",
    find: 'resultEl.appendChild(el("p", "sc-check ok", "The score calculated here (" + calc.total + ") matches the score recorded by the site."));',
    replace: 'resultEl.appendChild(el("p", "sc-check ok", "The score calculated here (" + calc.total + ") matches the score recorded by the site." + (recorded.breakdown && recorded.breakdown.late ? " This was a late entry, so it counts at " + Math.round(Number(recorded.breakdown.late_factor) * 100) + "%: " + recorded.points + " points." : "")));' },
  { file: "scorecard.js",
    find: 'var recPts = rec ? rec.points : 0;',
    replace: 'var recPts = rec ? (rec.breakdown && rec.breakdown.late ? Number(rec.breakdown.raw_total) : rec.points) : 0;' },
];

const checkOnly = process.argv.includes("--check");
const files = new Map();
const problems = [];
let done = 0;
let already = 0;

for (const e of EDITS) {
  if (!files.has(e.file)) {
    try { files.set(e.file, await readFile(e.file, "utf8")); }
    catch { files.set(e.file, null); }
  }
  const text = files.get(e.file);
  if (text === null) { problems.push(e.file + ": file not found (run this from the project root)"); continue; }
  const crlf = text.includes("\r\n");
  const eol = (s) => (crlf ? s.replace(/\n/g, "\r\n") : s);
  const find = eol(e.find);
  const replace = eol(e.replace);
  const count = text.split(find).length - 1;
  if (text.includes(replace)) {
    already++;                       // the edit is already in the file (its new text may itself contain the old text)
  } else if (count === 1) {
    files.set(e.file, text.replace(find, () => replace));
    done++;
  } else {
    problems.push(e.file + ": " + (count === 0 ? "cannot find" : "found " + count + " times") + ": " + e.find.slice(0, 90));
  }
}

if (problems.length) {
  console.log("Nothing was changed. These edits could not be made:\n  " + problems.join("\n  "));
  console.log("\nSend me those lines (and the few lines around them in your file) and I will adapt the edit.");
  process.exit(1);
}

if (checkOnly) {
  console.log("All " + EDITS.length + " edits can be made (" + done + " to do, " + already + " already done). Nothing was changed.");
} else {
  for (const [file, text] of files) { if (text !== null) { await writeFile(file, text); } }
  console.log("Done: " + done + " edit(s) made, " + already + " already in place.");
}
