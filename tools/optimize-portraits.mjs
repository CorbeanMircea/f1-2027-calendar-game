// Lights Out: prepare driver portraits for the web.
//
// Usage (from the project root):
//   1. Download each driver's photo from Wikimedia Commons into assets/portraits-originals/ and name it after the
//      driver's three-letter code in lower case, for example ver.jpg, nor.png, ant.jpg (the code shown on the
//      prediction tiles). Use photos with a free licence (CC0, public domain, CC BY, CC BY-SA).
//   2. Add one row per photo to assets/portraits-originals/credits.csv: code,author,licence,source_url
//      (source_url is the Commons file page). A photo without a credits row is skipped on purpose.
//   3. npm install --no-save sharp
//   4. node tools/optimize-portraits.mjs
//
// Optional: assets/portraits-originals/focus.csv (header: code,x,y,zoom) says where the face is, so the crop is centred on it.
//   x and y are percentages across and down the original photo (0 to 100); zoom is 1 (widest crop, the default) up to 3.
//   Use tools/portrait-focus.html to set them by clicking on each face. Without a row the crop is centred at x 50, y 35.
//
// Output: assets/portraits/<code>.webp (480 x 360, cropped around the face, metadata removed, under about 45 KB)
// and portraits.js (the list the site reads, including the credits shown on credits.html).
// Run it again after adding or replacing photos or changing focus.csv. The originals are git-ignored; credits.csv and
// focus.csv are committed.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "assets/portraits-originals";
const OUT = "assets/portraits";
const WIDTH = 480;
const HEIGHT = 360;
const MAX_BYTES = 45 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);

// Minimal CSV reader: quoted fields, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; }
      else { field += c; }
    } else if (c === '"') { quoted = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") { i++; }
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) { rows.push(row); }
      row = [];
    } else { field += c; }
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) { rows.push(row); }
  return rows;
}

let files;
try {
  files = await readdir(SRC);
} catch {
  console.error("Folder not found: " + SRC + ". Create it, add the photos and credits.csv.");
  process.exit(1);
}

let csv;
try {
  csv = parseCsv(await readFile(path.join(SRC, "credits.csv"), "utf8"));
} catch {
  console.error("Missing " + SRC + "/credits.csv (header: code,author,licence,source_url).");
  process.exit(1);
}

const header = (csv[0] || []).map((x) => x.trim().toLowerCase());
const col = (name) => header.indexOf(name);
if (["code", "author", "licence", "source_url"].some((n) => col(n) === -1)) {
  console.error("credits.csv must start with the header: code,author,licence,source_url");
  process.exit(1);
}

const credits = new Map();
for (const r of csv.slice(1)) {
  const code = (r[col("code")] || "").trim().toLowerCase();
  if (!code) { continue; }
  credits.set(code, {
    author: (r[col("author")] || "").trim(),
    licence: (r[col("licence")] || "").trim(),
    url: (r[col("source_url")] || "").trim()
  });
}

// Face position per photo (optional).
const focus = new Map();
try {
  const rows = parseCsv(await readFile(path.join(SRC, "focus.csv"), "utf8"));
  const h = (rows[0] || []).map((x) => x.trim().toLowerCase());
  const at = (n) => h.indexOf(n);
  if (at("code") === -1 || at("x") === -1 || at("y") === -1) {
    console.error("focus.csv must start with the header: code,x,y,zoom");
    process.exit(1);
  }
  for (const r of rows.slice(1)) {
    const code = (r[at("code")] || "").trim().toLowerCase();
    const x = Number(r[at("x")]);
    const y = Number(r[at("y")]);
    const zoom = at("zoom") === -1 || (r[at("zoom")] || "").trim() === "" ? 1 : Number(r[at("zoom")]);
    if (code && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom)) {
      focus.set(code, { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)), zoom: Math.min(3, Math.max(1, zoom)) });
    }
  }
} catch {
  // focus.csv is optional
}

await mkdir(OUT, { recursive: true });

const entries = {};
const skipped = [];
for (const file of files.sort()) {
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_EXT.has(ext)) { continue; }
  const code = path.basename(file, path.extname(file)).toLowerCase();
  if (!/^[a-z0-9]{2,4}$/.test(code)) { skipped.push(file + ": name must be the driver code, for example ver.jpg"); continue; }

  const credit = credits.get(code);
  if (!credit || !credit.author || !credit.licence || !/^https:\/\//.test(credit.url)) {
    skipped.push(file + ": complete credits row needed in credits.csv (author, licence, https source_url)");
    continue;
  }

  // Crop window: as large as the photo allows at the tile's shape (divided by the zoom), centred on the face.
  const full = path.join(SRC, file);
  const meta = await sharp(full).metadata();
  const turned = meta.orientation && meta.orientation >= 5;
  const imgW = turned ? meta.height : meta.width;
  const imgH = turned ? meta.width : meta.height;
  const f = focus.get(code) || { x: 50, y: 35, zoom: 1 };
  const shape = WIDTH / HEIGHT;
  let cropW = imgW / imgH > shape ? imgH * shape : imgW;
  let cropH = imgW / imgH > shape ? imgH : imgW / shape;
  cropW = Math.max(16, Math.round(cropW / f.zoom));
  cropH = Math.max(12, Math.round(cropH / f.zoom));
  const left = Math.min(imgW - cropW, Math.max(0, Math.round((f.x / 100) * imgW - cropW / 2)));
  const top = Math.min(imgH - cropH, Math.max(0, Math.round((f.y / 100) * imgH - cropH / 2)));

  let quality = 82;
  let buffer;
  do {
    buffer = await sharp(full)
      .rotate()
      .extract({ left, top, width: cropW, height: cropH })
      .resize(WIDTH, HEIGHT)
      .webp({ quality })
      .toBuffer();
    quality -= 6;
  } while (buffer.length > MAX_BYTES && quality >= 40);

  await writeFile(path.join(OUT, code + ".webp"), buffer);
  entries[code] = { src: OUT + "/" + code + ".webp", author: credit.author, licence: credit.licence, url: credit.url };
  console.log("ok   " + code + "  " + Math.round(buffer.length / 1024) + " KB" + (focus.has(code) ? "" : "  (no focus.csv row: centred at 50, 35)"));
}

for (const code of credits.keys()) {
  if (!entries[code]) { skipped.push("credits row '" + code + "' has no usable photo"); }
}

const sorted = {};
Object.keys(entries).sort().forEach((k) => { sorted[k] = entries[k]; });
const body =
  "// Generated by tools/optimize-portraits.mjs. Do not edit by hand; edit credits.csv and run the tool again.\n" +
  "window.LO_PORTRAITS = " + JSON.stringify(sorted, null, 2) + ";\n";
await writeFile("portraits.js", body);

console.log("\n" + Object.keys(sorted).length + " portrait(s) written to " + OUT + " and portraits.js.");
if (skipped.length) { console.log("\nSkipped:\n  " + skipped.join("\n  ")); }
