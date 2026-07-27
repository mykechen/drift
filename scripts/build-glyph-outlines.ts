/**
 * Bake Archivo's glyph outlines at build time so fontkit never ships.
 *
 * fontkit is ~133 KB brotli and it exists at runtime to do one thing: turn a
 * character and a pair of axis values into an outline. That is a pure function
 * of the font, and the font does not change between builds — so it can be
 * evaluated here, once, instead of in every visitor's browser. Baking it also
 * takes `Archivo.ttf` (a further ~192 KB) off the wire entirely, since nothing
 * at runtime parses it any more.
 *
 * **What is baked is the raw quadratic outline, not a flattened polygon.** That
 * is the whole design and it is worth being explicit about, because flattening
 * here would have been the obvious move and it is the wrong one:
 *
 * - Curve subdivision and the Ramer–Douglas–Peucker simplification after it are
 *   both driven by a *tolerance*. Bake past them and the tolerance is frozen
 *   into the data, and `/debug/glyphs` — whose entire job is sweeping that
 *   tolerance to judge the collider budget — stops being able to sweep it.
 * - Control points are the thing a variable font actually interpolates. Taking
 *   them straight across means this file's interpolation is the same operation
 *   the font format performs, rather than an approximation layered on one.
 * - It is also simply smaller: an `o` is 30 commands, where its flattened ring
 *   is several times that.
 *
 * So the runtime loses fontkit's *parsing* and keeps every line of its own
 * geometry pipeline. Phase 3's SDF reads the true curves from here too.
 *
 * Usage:
 *   pnpm bake:glyphs             write src/engine/glyph-outlines.bin
 *   pnpm bake:glyphs --report    sweep candidate axis grids and report error
 */

import * as fontkit from "fontkit";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FONT_PATH = resolve(ROOT, "fonts/Archivo.ttf");
const OUTPUT_PATH = resolve(ROOT, "src/engine/glyph-outlines.bin");

/**
 * Printable ASCII. Wider than the corpus — which is a-z — because the *draft*
 * word renders whatever is typed, including capitals, digits and punctuation
 * that will be refused on commit. A visitor typing `Boulder7!` must see it.
 */
const FIRST_CODE_POINT = 0x20;
const LAST_CODE_POINT = 0x7e;

/**
 * Ligatures Archivo substitutes by default, baked as entries of their own.
 *
 * Dropping fontkit means dropping `layout()`, and `layout()` is what applies
 * the `liga` feature — so baking one glyph per character would have quietly
 * turned ligatures off and changed how `fire`, `flint` and `office` are drawn
 * *and shaped*, since a ligature is one compound body rather than two. Probing
 * every printable-ASCII pair and triple found exactly five substitutions, the
 * classic Latin set, so the runtime needs only a greedy longest-match over a
 * five-entry table rather than a GSUB implementation.
 *
 * Verified by enumeration, not assumed: 676 pairs and 857,375 triples were
 * shaped and compared against their character counts.
 */
const LIGATURES = ["ffi", "ffl", "ff", "fi", "fl"] as const;

/** Format magic and version, so a stale file fails loudly instead of subtly. */
const MAGIC = 0x59_4c_47_44; // "DGLY" little-endian
const VERSION = 1;

const COMMAND_IDS: Readonly<Record<string, number>> = {
  moveTo: 0,
  lineTo: 1,
  quadraticCurveTo: 2,
  closePath: 3,
};

interface GlyphOutline {
  /** The characters this entry draws: one for a glyph, two or three for a ligature. */
  readonly sequence: string;
  /** One id per path command, constant across axis values. */
  readonly commands: number[];
  /** Flat coordinates for every command, per axis sample. */
  readonly coordinates: number[][];
  /** Advance width in font units, per axis sample. */
  readonly advances: number[];
  /**
   * True when the glyph is *not* point-compatible across the grid and has been
   * baked at one setting only. See `bakeGrid`.
   */
  readonly staticOutline: boolean;
}

function evenlySpaced(from: number, to: number, count: number): number[] {
  if (count <= 1) return [from];
  return Array.from(
    { length: count },
    (_, index) => from + ((to - from) * index) / (count - 1),
  );
}

/**
 * Read one glyph's path at one axis setting: the command ids and the flat
 * coordinate list, in order.
 */
function readPath(
  font: fontkit.Font,
  sequence: string,
): {
  commands: number[];
  coordinates: number[];
  advance: number;
} {
  const glyphs = font.layout(sequence).glyphs;
  const commands: number[] = [];
  const coordinates: number[] = [];
  let advance = 0;

  for (const glyph of glyphs) {
    advance += glyph.advanceWidth;
    for (const command of glyph.path.commands) {
      const id = COMMAND_IDS[command.command];
      if (id === undefined) {
        throw new Error(
          `Drift: unexpected path command "${command.command}" in "${sequence}". ` +
            `Archivo is TrueType and should only emit moveTo/lineTo/quadraticCurveTo/closePath.`,
        );
      }
      commands.push(id);
      for (const argument of command.args) coordinates.push(argument);
    }
  }
  return { commands, coordinates, advance };
}

/**
 * Bilinear interpolation over the sample grid, in the same order the runtime
 * uses. Kept here so `--report` measures the decoder's actual arithmetic rather
 * than an idealised version of it.
 */
function interpolate(
  samplesByIndex: readonly number[][],
  weights: readonly number[],
  widths: readonly number[],
  wght: number,
  wdth: number,
  length: number,
): number[] {
  function bracket(
    values: readonly number[],
    at: number,
  ): [number, number, number] {
    let upper = 1;
    while (upper < values.length - 1 && values[upper]! < at) upper += 1;
    const lower = upper - 1;
    const span = values[upper]! - values[lower]!;
    const t = span === 0 ? 0 : (at - values[lower]!) / span;
    return [lower, upper, Math.max(0, Math.min(1, t))];
  }

  const [w0, w1, wt] = bracket(weights, wght);
  const [d0, d1, dt] = bracket(widths, wdth);
  const at = (wi: number, di: number): number[] =>
    samplesByIndex[wi * widths.length + di]!;

  const a = at(w0, d0);
  const b = at(w1, d0);
  const c = at(w0, d1);
  const d = at(w1, d1);

  const out = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    const low = a[i]! + (b[i]! - a[i]!) * wt;
    const high = c[i]! + (d[i]! - c[i]!) * wt;
    out[i] = low + (high - low) * dt;
  }
  return out;
}

/**
 * Bake every glyph across the axis grid.
 *
 * Point-compatibility is the assumption the whole approach rests on, so it is
 * *checked* rather than trusted — the same discipline `export_onnx.py` applies
 * to vocabulary contiguity. Interpolating index-by-index between outlines whose
 * point counts disagree does not fail, it silently produces garbage geometry,
 * which is exactly the failure mode worth spending a check on.
 *
 * Archivo very nearly holds: 94 of 95 printable ASCII glyphs are compatible
 * across the whole grid. The exception is `$`, whose construction gains eight
 * coordinates at the heavy end. Rather than refuse to render it — the draft
 * word must show whatever is typed — a glyph that fails the check is baked at
 * one setting and marked static. It then does not respond to weight, which for
 * a character that can never appear in a scored word is invisible. Any glyph
 * that lands here is named in the bake output so the exception stays a
 * decision rather than a silent degradation.
 */
function bakeGrid(
  base: fontkit.Font,
  weights: readonly number[],
  widths: readonly number[],
): GlyphOutline[] {
  const variations = weights.flatMap((wght) =>
    widths.map((wdth) => base.getVariation({ wght, wdth })),
  );

  const sequences: string[] = [];
  for (let cp = FIRST_CODE_POINT; cp <= LAST_CODE_POINT; cp += 1) {
    sequences.push(String.fromCodePoint(cp));
  }
  sequences.push(...LIGATURES);

  const outlines: GlyphOutline[] = [];
  for (const sequence of sequences) {
    const perSample = variations.map((font) => readPath(font, sequence));
    const reference = perSample[0]!;

    const compatible = perSample.every(
      (sample) =>
        sample.commands.length === reference.commands.length &&
        sample.commands.every(
          (id, index) => id === reference.commands[index],
        ) &&
        sample.coordinates.length === reference.coordinates.length,
    );

    outlines.push({
      sequence,
      commands: reference.commands,
      coordinates: compatible
        ? perSample.map((sample) => sample.coordinates)
        : [reference.coordinates],
      advances: compatible
        ? perSample.map((sample) => sample.advance)
        : [reference.advance],
      staticOutline: !compatible,
    });
  }
  return outlines;
}

/**
 * Largest interpolation error against fontkit's own output, in font units.
 *
 * Reported twice, because the two numbers mean different things. `lowercase`
 * covers a–z, which is the whole of the scored corpus and therefore every word
 * that becomes a physics body — that is the number the geometry has to meet.
 * `coordinate` covers all of printable ASCII, most of which can only ever
 * appear in the uncommitted draft at the cursor, where a fraction of a pixel of
 * outline drift has nothing to disagree with.
 */
function measureError(
  base: fontkit.Font,
  outlines: readonly GlyphOutline[],
  weights: readonly number[],
  widths: readonly number[],
): { coordinate: number; lowercase: number; advance: number } {
  // Deliberately off-grid: midpoints are where linear interpolation is worst.
  const probeWeights = [317, 452, 500, 631, 725, 788];
  const probeWidths = [88, 97, 100, 109, 118, 123];

  // a-z and the ligatures they form: everything a scored word can be made of.
  const isCorpus = (sequence: string): boolean => /^[a-z]+$/.test(sequence);

  let worstCoordinate = 0;
  let worstLowercase = 0;
  let worstAdvance = 0;
  for (const wght of probeWeights) {
    for (const wdth of probeWidths) {
      const truth = base.getVariation({ wght, wdth });
      for (const outline of outlines) {
        // A static glyph is knowingly frozen; measuring it would report the
        // size of a deviation that was chosen, not one that slipped in.
        if (outline.staticOutline) continue;
        const actual = readPath(truth, outline.sequence);
        const guess = interpolate(
          outline.coordinates,
          weights,
          widths,
          wght,
          wdth,
          actual.coordinates.length,
        );
        for (let i = 0; i < actual.coordinates.length; i += 1) {
          const error = Math.abs(guess[i]! - actual.coordinates[i]!);
          worstCoordinate = Math.max(worstCoordinate, error);
          if (isCorpus(outline.sequence)) {
            worstLowercase = Math.max(worstLowercase, error);
          }
        }
        const advance = interpolate(
          outline.advances.map((value) => [value]),
          weights,
          widths,
          wght,
          wdth,
          1,
        )[0]!;
        worstAdvance = Math.max(
          worstAdvance,
          Math.abs(advance - actual.advance),
        );
      }
    }
  }
  return {
    coordinate: worstCoordinate,
    lowercase: worstLowercase,
    advance: worstAdvance,
  };
}

function encode(
  outlines: readonly GlyphOutline[],
  unitsPerEm: number,
  weights: readonly number[],
  widths: readonly number[],
): Buffer {
  const chunks: Buffer[] = [];

  const header = Buffer.alloc(14);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(unitsPerEm, 6);
  header.writeUInt16LE(weights.length, 8);
  header.writeUInt16LE(widths.length, 10);
  header.writeUInt16LE(outlines.length, 12);
  chunks.push(header);

  const axes = Buffer.alloc((weights.length + widths.length) * 2);
  let cursor = 0;
  for (const value of [...weights, ...widths]) {
    axes.writeUInt16LE(Math.round(value), cursor);
    cursor += 2;
  }
  chunks.push(axes);

  for (const outline of outlines) {
    const sequence = Buffer.from(outline.sequence, "ascii");
    const meta = Buffer.alloc(7);
    meta.writeUInt8(sequence.length, 0);
    meta.writeUInt16LE(outline.commands.length, 1);
    meta.writeUInt16LE(outline.coordinates[0]!.length, 3);
    // Sample count doubles as the static flag: an entry carrying one sample is
    // used at that sample for every axis value.
    meta.writeUInt16LE(outline.coordinates.length, 5);
    chunks.push(meta, sequence, Buffer.from(outline.commands));

    const sampleCount = outline.coordinates.length;
    const coordinateCount = outline.coordinates[0]!.length;
    const numbers = Buffer.alloc(sampleCount * (coordinateCount + 1) * 2);
    let offset = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      // Advances first, then coordinates, so a decoder can skip geometry when
      // it only needs to measure a word.
      //
      // Every sample past the first is stored as a *difference* from sample 0.
      // The eighteen samples of a glyph are near-identical, so the differences
      // are small numbers clustered near zero where the absolute coordinates
      // are large and spread out — worth 16 KB of brotli (120.5 → 104.2) for
      // one subtraction per value.
      const base = outline.coordinates[0]!;
      const current = outline.coordinates[sample]!;
      const advance =
        sample === 0
          ? outline.advances[0]!
          : outline.advances[sample]! - outline.advances[0]!;
      numbers.writeInt16LE(Math.round(advance), offset);
      offset += 2;
      for (let index = 0; index < coordinateCount; index += 1) {
        const value =
          sample === 0 ? current[index]! : current[index]! - base[index]!;
        const rounded = Math.round(value);
        if (rounded < -32768 || rounded > 32767) {
          throw new Error(
            `Drift: coordinate ${String(rounded)} does not fit in int16.`,
          );
        }
        numbers.writeInt16LE(rounded, offset);
        offset += 2;
      }
    }
    chunks.push(numbers);
  }

  return Buffer.concat(chunks);
}

function main(): void {
  const base = fontkit.create(readFileSync(FONT_PATH)) as fontkit.Font;

  if (process.argv.includes("--report")) {
    // Candidate grids. The ones naming 100 explicitly are there because the
    // draft word renders at the neutral `wdth 100`: making it a sample point
    // costs one column and makes every uncommitted word exact rather than
    // interpolated.
    const candidates: { weights: number[]; widths: number[] }[] = [
      { weights: evenlySpaced(300, 800, 2), widths: evenlySpaced(85, 125, 2) },
      { weights: evenlySpaced(300, 800, 3), widths: [85, 100, 125] },
      { weights: evenlySpaced(300, 800, 6), widths: evenlySpaced(85, 125, 3) },
      { weights: evenlySpaced(300, 800, 6), widths: [85, 100, 125] },
      { weights: evenlySpaced(300, 800, 6), widths: [85, 100, 112, 125] },
      { weights: evenlySpaced(300, 800, 11), widths: [85, 100, 112, 125] },
    ];

    process.stdout.write(
      "grid            all ASCII    a-z        advance    bytes\n",
    );
    for (const { weights, widths } of candidates) {
      const outlines = bakeGrid(base, weights, widths);
      const error = measureError(base, outlines, weights, widths);
      const bytes = encode(outlines, base.unitsPerEm, weights, widths).length;
      process.stdout.write(
        `${String(weights.length)}x${String(widths.length)} [${widths.join(",")}]`.padEnd(
          16,
        ) +
          `${error.coordinate.toFixed(2)}`.padEnd(13) +
          `${error.lowercase.toFixed(2)}`.padEnd(11) +
          `${error.advance.toFixed(2)}`.padEnd(11) +
          `${String(bytes)}\n`,
      );
    }
    return;
  }

  const outlines = bakeGrid(base, SHIPPING_WEIGHTS, SHIPPING_WIDTHS);
  const weights = SHIPPING_WEIGHTS;
  const widths = SHIPPING_WIDTHS;
  const error = measureError(base, outlines, weights, widths);
  const encoded = encode(outlines, base.unitsPerEm, weights, widths);
  writeFileSync(OUTPUT_PATH, encoded);

  const frozen = outlines
    .filter((outline) => outline.staticOutline)
    .map((outline) => outline.sequence);

  process.stdout.write(
    `baked ${String(outlines.length)} glyphs at ${String(weights.length)}x${String(widths.length)} axis samples\n` +
      `worst interpolation error: ${error.coordinate.toFixed(2)} font units ` +
      `(${(error.coordinate / base.unitsPerEm).toFixed(5)} em), advance ${error.advance.toFixed(2)} units\n` +
      `not point-compatible, baked static: ${frozen.length === 0 ? "none" : frozen.join(" ")}\n` +
      `${String(encoded.length)} bytes to ${OUTPUT_PATH}\n`,
  );
}

/**
 * The shipping grid, chosen by measurement rather than by taste — `--report`
 * prints the table this came from.
 *
 * **Both axes sample their masters, and that is the whole story.** Archivo's
 * design space turns out to be bilinear between masters, so a grid that lands
 * on them reproduces the font and a grid that misses one does not. Weights at
 * every 100 hit the nine named instances. The width that matters is **100** —
 * the default, and a master: an otherwise identical grid using 105 instead
 * measures 19.97 units of error where this one measures 2.33, a factor of nine
 * from one sample point. Sampling further buys nothing (6×4 and 11×4 both still
 * measure 2.3), which says the residual is `getVariation`'s integer rounding
 * rather than interpolation — the arithmetic is exact and this is the floor.
 *
 * For scale: 2.33 font units is 0.0023 em, against a flattening tolerance of
 * 1/32 em that Phase 2 established as invisible. Advances come out exact.
 */
const SHIPPING_WEIGHTS = [300, 400, 500, 600, 700, 800];
const SHIPPING_WIDTHS = [85, 100, 125];

main();
