// Lights Out: optimise hero photographs for the web.
//
// Usage (from the project root):
//   1. Put the original downloads in assets/hero-originals/ and name each file after
//      its event stem, for example mexico-city.jpg, monaco.jpg, united-states.png.
//   2. npm install --no-save sharp
//   3. node tools/optimize-hero.mjs
//
// Output: assets/hero/<stem>.jpg, 1920 px wide at most, progressive JPEG, metadata removed,
// quality lowered step by step until the file is under 220 KB.
// The homepage shows the photo in monochrome at about 30 percent opacity, so this is plenty.

import { readdir, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "assets/hero-originals";
const OUT = "assets/hero";
const MAX_WIDTH = 1920;
const MAX_BYTES = 220 * 1024;

// Event stems used by the frontend (event id without the year; Mexico 2027 shares mexico-city).
const STEMS = new Set([
  "bahrain", "saudi-arabia", "australia", "japan", "china", "miami", "canada", "monaco",
  "portugal", "great-britain", "austria", "belgium", "hungary", "italy", "spain", "azerbaijan",
  "turkey", "singapore", "united-states", "mexico-city", "brazil", "las-vegas", "qatar", "abu-dhabi"
]);

let files;
try {
  files = await readdir(SRC);
} catch {
  console.error("Folder not found: " + SRC + ". Create it and add the original photos.");
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

let done = 0;
for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".avif"].includes(ext)) continue;
  const stem = path.basename(file, ext).toLowerCase();
  if (!STEMS.has(stem)) {
    console.warn("SKIPPED " + file + ": '" + stem + "' is not a known event stem.");
    continue;
  }
  const target = path.join(OUT, stem + ".jpg");
  let quality = 76;
  let size = 0;
  while (true) {
    await sharp(path.join(SRC, file))
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toFile(target);
    size = (await stat(target)).size;
    if (size <= MAX_BYTES || quality <= 50) break;
    quality -= 4;
  }
  console.log(stem + ".jpg  " + Math.round(size / 1024) + " KB  (quality " + quality + ")");
  done++;
}
console.log(done + " photo(s) written to " + OUT + ".");
