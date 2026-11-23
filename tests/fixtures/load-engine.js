// Lights Out: loads scorecard-engine.js (a browser script) into Node for unit tests, without changing the file.
// Playwright's test loader rewrites top-level `this`, which that script relies on, so it is evaluated with Node's
// vm module instead. The results are copied through JSON so they behave like ordinary objects in the tests.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadScorecardEngine() {
  const file = path.join(__dirname, "..", "..", "scorecard-engine.js");
  const source = fs.readFileSync(file, "utf8");
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(source, sandbox, { filename: file });
  const raw = sandbox.module.exports;
  if (!raw || typeof raw.explain !== "function") {
    throw new Error("scorecard-engine.js did not export explain()");
  }
  return {
    explain: function (type, picks, actual) {
      return JSON.parse(JSON.stringify(raw.explain(type, picks, actual)));
    }
  };
}

module.exports = { loadScorecardEngine };
