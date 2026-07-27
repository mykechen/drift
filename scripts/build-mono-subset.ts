/**
 * Subset IBM Plex Mono to the handful of glyphs Drift actually sets in it, and
 * write the woff2 the piece ships.
 *
 * The mono face appears at 10–12pt in four places and nowhere else: the mobile
 * caption, the footer, the credit line, and the watermark burned into an
 * exported still. That is a few dozen glyphs against a 173 KB source, so
 * shipping the whole font would be roughly forty times the bytes for characters
 * nobody will ever see.
 *
 * **Why ship a face at all rather than use `ui-monospace`.** The exported PNG's
 * watermark is drawn on the visitor's machine. A system stack means every still
 * that leaves the site carries a different typeface — SF Mono on a Mac,
 * Consolas on Windows — and the watermark is the one piece of the identity that
 * travels. `brand-guidelines.md` also treats "the mono face" as an identity
 * element, which wants a name.
 *
 * Run with `pnpm bake:mono`. Like `build-glyph-outlines.ts` this is build-time
 * only; `fonttools` is invoked through `uv` and never enters the repo's
 * dependencies.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Source fonts live outside `public/`, deliberately.
 *
 * Vite copies everything in `public/` into the build, so a source font kept
 * there is *deployed* even when nothing links to it — `Archivo.ttf` was
 * shipping 658 KB to the edge that no visitor ever requested. It never showed
 * up in `pnpm measure`, which follows references from the entry point rather
 * than listing the bucket. Build inputs go in `fonts/`; only the subset lands
 * in `public/`.
 */
const SOURCE = resolve(ROOT, "fonts/IBMPlexMono-Regular.ttf");
const OUTPUT = resolve(ROOT, "public/fonts/plex-mono-subset.woff2");

/**
 * Every character the piece sets in mono, and no others.
 *
 * Assembled from the actual strings rather than from a guessed range, because a
 * guessed range is how a subset quietly stops being a subset. The digits are
 * for a possible dated watermark; the middle dot separates the footer's credit
 * line in `brand-guidelines.md`.
 */
const STRINGS: readonly string[] = [
  // Mobile fallback caption
  "Drift is made for a keyboard. Come back on a desktop.",
  // Footer and credit line
  "drift",
  "GitHub",
  "·",
  // Watermark: the domain is still TBD, so the whole lowercase alphabet plus
  // the punctuation a hostname can contain is kept.
  "abcdefghijklmnopqrstuvwxyz",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "0123456789",
  " .,-–—:/'’()",
];

function subsetCharacters(): string {
  return [...new Set(STRINGS.join(""))].sort().join("");
}

/** Fail loudly rather than shipping a subset that stopped being one. */
const MAX_OUTPUT_BYTES = 8 * 1024;

function main(): void {
  const characters = subsetCharacters();
  const codePoints = [...characters]
    .map((character) => character.codePointAt(0)!.toString(16).toUpperCase())
    .join(",");

  process.stdout.write(
    `subsetting ${String([...characters].length)} characters from ` +
      `${String(statSync(SOURCE).size)} bytes\n`,
  );

  execFileSync(
    "uv",
    [
      "run",
      "--with",
      "fonttools[woff]",
      "pyftsubset",
      SOURCE,
      `--output-file=${OUTPUT}`,
      `--unicodes=${codePoints}`,
      "--flavor=woff2",
      // Keep the name and licence records: the OFL requires the copyright
      // notice to travel with the font, and stripping them to save bytes would
      // be both rude and a licence violation.
      "--name-IDs=0,1,2,3,4,5,6,7,13,14",
      "--no-hinting",
      "--desubroutinize",
      "--layout-features=",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  const bytes = statSync(OUTPUT).size;
  process.stdout.write(`wrote ${OUTPUT} — ${String(bytes)} bytes\n`);

  if (bytes > MAX_OUTPUT_BYTES) {
    throw new Error(
      `subset is ${String(bytes)} bytes, over the ${String(MAX_OUTPUT_BYTES)} ` +
        `byte ceiling. Either the character set grew or the subsetter stopped ` +
        `subsetting; check --unicodes before raising this.`,
    );
  }
}

main();
