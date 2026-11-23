// Lights Out: minimal static file server for tests (no dependencies).
// Serves the repository folder on 127.0.0.1 only. Usage: node tests/tools/static-server.js [port]
// It refuses hidden files (.env, .git ...), node_modules and test output, so nothing private is served.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8"
};

const BLOCKED_SEGMENTS = new Set(["node_modules", "test-results", "playwright-report", "blob-report"]);

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, headers || {}));
  res.end(body);
}

const server = http.createServer(function (req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  } catch (e) {
    return send(res, 400, "Bad request");
  }

  if (pathname === "/") { pathname = "/index.html"; }

  const segments = pathname.split("/").filter(Boolean);
  const hidden = segments.some(function (s) { return s.charAt(0) === "." || BLOCKED_SEGMENTS.has(s); });
  if (hidden || pathname.indexOf("\0") !== -1) {
    return send(res, 404, "Not found");
  }

  const file = path.join(ROOT, path.normalize(pathname));
  if (file !== ROOT && file.indexOf(ROOT + path.sep) !== 0) {
    return send(res, 404, "Not found");
  }

  fs.stat(file, function (err, stat) {
    if (err || !stat.isFile()) { return send(res, 404, "Not found"); }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-store" });
    if (req.method === "HEAD") { return res.end(); }
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("Lights Out test server: http://127.0.0.1:" + PORT + "  (serving " + ROOT + ")");
});
