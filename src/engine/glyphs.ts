/**
 * Word → glyph outlines → convex hulls.
 *
 * This is the pipeline behind the piece's central claim: a word is not a
 * picture of a word sitting on a rectangle, it is its own letterforms as a
 * physics body. Everything here exists to turn a string into a set of convex
 * polygons Rapier can collide.
 *
 * Rendering does not use these polygons. Glyphs are drawn from an SDF, which
 * needs no geometry at all. That separation is what lets this side be coarse:
 * physics only needs a silhouette that feels right on contact, so curves are
 * flattened far more roughly here than they would be for drawing. Coarser also
 * means fewer colliders, which is the difference between a room that holds 200
 * words at 120Hz and one that does not.
 *
 * Coordinates are em units — font units divided by `unitsPerEm` — with the
 * word centred on its own bounding box. Callers scale to world units.
 *
 * **There is no font parser here.** Phase 2.5 moved outline extraction to build
 * time: `scripts/build-glyph-outlines.ts` evaluates Archivo across a grid of
 * axis samples and writes `glyph-outlines.bin`, and this file interpolates
 * between those samples. That took fontkit (~133 KB) and `Archivo.ttf`
 * (~192 KB) off the wire for ~107 KB of baked outlines. What is baked is the
 * raw quadratic control points, not flattened polygons, so every line of the
 * geometry pipeline below is unchanged and the flattening tolerance is still a
 * runtime knob.
 */

import earcut from "earcut";
import outlinesUrl from "./glyph-outlines.bin?url";
import type { FontAxes } from "../design/typography";

/**
 * How far a flattened curve may sit from the true curve, in em units.
 *
 * This is the single most important number in the file, because it sets the
 * collider budget. Every extra segment on a curve is another reflex vertex on
 * the inside of a counter, and a convex piece cannot span a reflex vertex — so
 * segment count drives hull count almost linearly, and hull count times two
 * hundred words is what the physics step has to carry.
 *
 * It is chosen against the room, not against the outline. A word stands
 * roughly 80px tall on a 900px canvas, so one em is about 80px and this
 * tolerance is a little over two pixels of deviation on the inside of an `o` —
 * far below what a collision could express, and invisible against an SDF that
 * draws from the true curve regardless. Verified by eye at /debug/glyphs.
 *
 * Coarsening it was tried as a performance lever and does not work. Going to
 * 1/16 em halves the colliders in a full room — 47 per word down to 26, 7,993
 * down to 5,253 — and leaves the physics step within noise of where it was
 * (22.2ms against 23ms). The cost of a crowded room is the constraint solver
 * working over a large island of awake bodies, not the number of colliders in
 * it. So this stays at the value that looks right rather than the value that
 * was supposed to be faster.
 */
export const FLATTEN_TOLERANCE_EM = 1 / 32;

/** Guard against a pathological curve subdividing without bound. */
const MAX_SEGMENTS_PER_CURVE = 16;

/** Command ids, mirrored from `scripts/build-glyph-outlines.ts`. */
const COMMAND_MOVE_TO = 0;
const COMMAND_LINE_TO = 1;
const COMMAND_QUADRATIC_TO = 2;
const COMMAND_CLOSE_PATH = 3;

/** Header magic, `DGLY` little-endian. A stale file must fail loudly. */
const OUTLINE_MAGIC = 0x59_4c_47_44;
const OUTLINE_VERSION = 1;

/**
 * Axis values are rounded to this before being used as a cache key.
 *
 * `getVariation` rebuilds glyf outlines and is far too slow to run on every
 * frame of a commit spring. Weight quantised to 5 units is imperceptible —
 * Archivo's designed masters are 100 apart — and turns a continuous spring
 * into a few dozen cache hits.
 */
const AXIS_CACHE_QUANTUM = 5;

export interface WordGeometry {
  /** Convex polygons for physics. Flat `[x0, y0, x1, y1, …]` in em units. */
  readonly hulls: readonly Float32Array[];
  /** Closed contours for debug drawing and SDF generation. Same units. */
  readonly contours: readonly Float32Array[];
  /**
   * The triangulation, as flat `[x, y]` pairs, three vertices per triangle.
   *
   * No longer what draws the word — the SDF does, from `path`. Kept because
   * /debug/glyphs draws it to show what the colliders were actually cut from,
   * which is the one view where the coarse version is the interesting one.
   */
  readonly triangles: Float32Array;
  /** Triangles earcut produced before convex merging. Diagnostic only. */
  readonly triangleCount: number;
  /** The true curves, for drawing. See `WordPath`. */
  readonly path: WordPath;
  /** Bounding box of the whole word, em units. */
  readonly width: number;
  readonly height: number;
}

/**
 * Just enough to draw a word. No collision geometry.
 *
 * This is the in-progress word at the cursor, which per DESIGN.md is "NOT a
 * physics body" — ordinary rendered text until it commits. Skipping the convex
 * decomposition matters because this is rebuilt on every keystroke and merging
 * is the expensive half of the pipeline.
 */
export interface WordOutline {
  /** Flat `[x, y]` pairs, three vertices per triangle, em units, centred. */
  readonly triangles: Float32Array;
  /** The true curves, for drawing. See `WordPath`. */
  readonly path: WordPath;
  readonly width: number;
  readonly height: number;
}

/**
 * A word's outline as curves rather than polygons — what the SDF is drawn from.
 *
 * This is the payoff of baking control points instead of flattened rings. The
 * colliders are deliberately coarse, because a collision only needs a
 * silhouette that feels right; the *picture* is held to a different standard,
 * and here it gets the true quadratics at whatever precision the rasteriser can
 * manage. Command ids and arity match the baked format: moveTo and lineTo take
 * two coordinates, a quadratic four, closePath none.
 *
 * Coordinates are em units, centred on exactly the same origin the flattened
 * contours were centred on — so the drawn word and the simulated body share a
 * frame, even though they no longer share a tessellation.
 */
export interface WordPath {
  readonly commands: Uint8Array;
  readonly coordinates: Float32Array;
}

export interface GlyphSource {
  /**
   * Geometry for a word at given axis values. Cached per word, axis pair and
   * tolerance. `tolerance` exists so /debug/glyphs can sweep it; the piece
   * always uses the default.
   */
  geometryFor(word: string, axes: FontAxes, tolerance?: number): WordGeometry;
  /** Drawable triangles only, for the uncommitted word. Skips hull merging. */
  outlineFor(word: string, axes: FontAxes, tolerance?: number): WordOutline;
  /** Advance width of a word in em units, without building geometry. */
  advanceFor(word: string, axes: FontAxes): number;
}

/** Command ids in a `WordPath`, mirrored from the baked format. */
export const PATH_MOVE_TO = 0;
export const PATH_LINE_TO = 1;
export const PATH_QUADRATIC_TO = 2;
export const PATH_CLOSE = 3;

// --- Curve flattening -------------------------------------------------------

/**
 * Segment count for a quadratic, from how far its control point pulls off the
 * chord. A nearly straight curve gets one segment; a tight bowl gets more.
 */
function segmentsForQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  tolerance: number,
): number {
  // Maximum deviation of a quadratic from its chord is a quarter of the
  // distance from the control point to the chord midpoint.
  const deviation = Math.hypot(cx - (x0 + x1) / 2, cy - (y0 + y1) / 2) / 2;
  if (deviation <= tolerance) return 1;
  const count = Math.ceil(Math.sqrt(deviation / tolerance));
  return Math.min(MAX_SEGMENTS_PER_CURVE, Math.max(1, count));
}

// --- Contours ---------------------------------------------------------------

interface Contour {
  /** Flat `[x, y, …]`, closed implicitly (last point is not the first repeated). */
  readonly points: number[];
  /**
   * Twice the signed area. Sign is winding direction, magnitude is area.
   * In TrueType, outer contours and their counters wind oppositely, which is
   * the only reliable way to tell a hole from a separate outer shape — `i` has
   * two contours and neither is a hole, `o` has two and the second is.
   */
  readonly signedArea: number;
}

/**
 * Drop points that sit within `tolerance` of the line they lie on.
 *
 * Ramer–Douglas–Peucker, run on the closed contour after flattening. This is
 * where the collider budget is actually won: subdividing curves turned out not
 * to be what inflates the vertex count — a TrueType outline arrives already
 * dense with points that exist for hinting and for smooth rendering, not for
 * shape. Removing them changes the silhouette by less than the tolerance and
 * removes reflex vertices wholesale, which is what lets convex pieces grow.
 *
 * The contour is split at its two extreme points first, because RDP needs open
 * polylines with fixed endpoints and a closed ring has none.
 */
function simplifyContour(
  points: readonly number[],
  tolerance: number,
): number[] {
  const count = points.length / 2;
  if (count < 4) return [...points];

  // Anchor on the point furthest from the first, so neither anchor can be a
  // point that should have been simplified away.
  let farthest = 0;
  let farthestDistance = -1;
  for (let i = 1; i < count; i += 1) {
    const distance =
      (points[i * 2]! - points[0]!) ** 2 +
      (points[i * 2 + 1]! - points[1]!) ** 2;
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }

  const kept: number[] = [];
  function simplify(from: number, to: number): void {
    const ax = points[(from % count) * 2]!;
    const ay = points[(from % count) * 2 + 1]!;
    const bx = points[(to % count) * 2]!;
    const by = points[(to % count) * 2 + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);

    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i += 1) {
      const px = points[(i % count) * 2]!;
      const py = points[(i % count) * 2 + 1]!;
      const distance =
        length < 1e-12
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }

    if (worst === -1) {
      kept.push(ax, ay);
      return;
    }
    simplify(from, worst);
    simplify(worst, to);
  }

  simplify(0, farthest);
  simplify(farthest, count);

  // Simplification can eat a contour down to something that no longer encloses
  // area; keep the original rather than feed earcut a degenerate ring.
  return kept.length >= 6 ? kept : [...points];
}

function signedAreaOf(points: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    total += points[i]! * points[j + 1]! - points[j]! * points[i + 1]!;
  }
  return total;
}

/**
 * Flatten one baked entry's path into closed polygonal contours, offset into
 * place.
 *
 * Takes the command ids and a flat coordinate array rather than a parsed font
 * glyph. The command stream is what the bake wrote and its arity is fixed:
 * moveTo and lineTo consume two coordinates, a quadratic four, closePath none.
 */
function contoursForEntry(
  commands: Uint8Array,
  coordinates: Float32Array,
  offsetX: number,
  scale: number,
  tolerance: number,
): Contour[] {
  const contours: Contour[] = [];
  let points: number[] = [];
  let cursorX = 0;
  let cursorY = 0;

  function push(x: number, y: number): void {
    points.push(x * scale + offsetX, y * scale);
  }

  function finish(): void {
    // Two points cannot enclose anything; a degenerate contour would only feed
    // earcut garbage.
    if (points.length >= 6) {
      const simplified = simplifyContour(points, tolerance);
      contours.push({
        points: simplified,
        signedArea: signedAreaOf(simplified),
      });
    }
    points = [];
  }

  let read = 0;
  for (const command of commands) {
    switch (command) {
      case COMMAND_MOVE_TO:
      case COMMAND_LINE_TO: {
        // A moveTo opens a new contour; a lineTo continues the current one.
        if (command === COMMAND_MOVE_TO) finish();
        cursorX = coordinates[read]!;
        cursorY = coordinates[read + 1]!;
        read += 2;
        push(cursorX, cursorY);
        break;
      }
      case COMMAND_QUADRATIC_TO: {
        const cx = coordinates[read]!;
        const cy = coordinates[read + 1]!;
        const x1 = coordinates[read + 2]!;
        const y1 = coordinates[read + 3]!;
        read += 4;
        const steps = segmentsForQuadratic(
          cursorX * scale,
          cursorY * scale,
          cx * scale,
          cy * scale,
          x1 * scale,
          y1 * scale,
          tolerance,
        );
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const inv = 1 - t;
          push(
            inv * inv * cursorX + 2 * inv * t * cx + t * t * x1,
            inv * inv * cursorY + 2 * inv * t * cy + t * t * y1,
          );
        }
        cursorX = x1;
        cursorY = y1;
        break;
      }
      case COMMAND_CLOSE_PATH: {
        finish();
        break;
      }
    }
  }
  finish();
  return contours;
}

// --- Hole assignment --------------------------------------------------------

function pointInPolygon(
  x: number,
  y: number,
  points: readonly number[],
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i]!;
    const yi = points[i + 1]!;
    const xj = points[j]!;
    const yj = points[j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

interface Shape {
  readonly outer: Contour;
  readonly holes: Contour[];
}

/**
 * Group contours into outer shapes and the holes inside them.
 *
 * The majority winding is taken to be "outer" rather than assuming a fixed
 * direction, because a glyph is always mostly outline and only occasionally
 * counter. Each hole is then assigned to the smallest outer contour that
 * contains it, which is what keeps the bowl of a `g` attached to the right
 * loop rather than to whichever one happened to come first.
 */
function groupIntoShapes(contours: readonly Contour[]): Shape[] {
  let positiveArea = 0;
  let negativeArea = 0;
  for (const contour of contours) {
    if (contour.signedArea > 0) positiveArea += contour.signedArea;
    else negativeArea -= contour.signedArea;
  }
  const outerSign = positiveArea >= negativeArea ? 1 : -1;

  const shapes: Shape[] = [];
  const holes: Contour[] = [];
  for (const contour of contours) {
    if (Math.sign(contour.signedArea) === outerSign) {
      shapes.push({ outer: contour, holes: [] });
    } else {
      holes.push(contour);
    }
  }

  for (const hole of holes) {
    const x = hole.points[0]!;
    const y = hole.points[1]!;
    let best: Shape | undefined;
    let bestArea = Infinity;
    for (const shape of shapes) {
      const area = Math.abs(shape.outer.signedArea);
      if (area < bestArea && pointInPolygon(x, y, shape.outer.points)) {
        best = shape;
        bestArea = area;
      }
    }
    // A hole with no container is a malformed glyph; dropping it leaves a solid
    // shape, which collides sanely, rather than corrupting the triangulation.
    best?.holes.push(hole);
  }
  return shapes;
}

// --- Triangulation and convex merging ---------------------------------------

function cross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** True if every turn in the ring has the same sign — i.e. the ring is convex. */
function isConvex(ring: readonly number[]): boolean {
  const count = ring.length / 2;
  if (count < 3) return false;
  let sign = 0;
  for (let i = 0; i < count; i += 1) {
    const a = i * 2;
    const b = ((i + 1) % count) * 2;
    const c = ((i + 2) % count) * 2;
    const turn = cross(
      ring[a]!,
      ring[a + 1]!,
      ring[b]!,
      ring[b + 1]!,
      ring[c]!,
      ring[c + 1]!,
    );
    // Collinear vertices are harmless; they just add a redundant point.
    if (turn === 0) continue;
    const next = turn > 0 ? 1 : -1;
    if (sign === 0) sign = next;
    else if (sign !== next) return false;
  }
  return true;
}

/**
 * Merge a triangle soup into as few convex polygons as possible.
 *
 * This is Hertel–Mehlhorn: repeatedly delete an internal edge shared by two
 * pieces when the union stays convex. It is not optimal, but it is guaranteed
 * within 4× of optimal and it is fast, and the difference between 60 colliders
 * per word and 12 is what decides whether 200 words simulate.
 *
 * Rings are stored as vertex-index lists so shared edges can be found by index
 * pair rather than by comparing coordinates, which floating point makes
 * unreliable.
 */
function mergeIntoConvexPieces(
  vertices: readonly number[],
  triangles: readonly number[],
): number[][] {
  const pieces: (number[] | null)[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    pieces.push([triangles[i]!, triangles[i + 1]!, triangles[i + 2]!]);
  }

  function ringCoords(ring: readonly number[]): number[] {
    const out: number[] = [];
    for (const index of ring)
      out.push(vertices[index * 2]!, vertices[index * 2 + 1]!);
    return out;
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < pieces.length; a += 1) {
      const ringA = pieces[a];
      if (!ringA) continue;

      for (let b = a + 1; b < pieces.length; b += 1) {
        const ringB = pieces[b];
        if (!ringB) continue;

        // Find a directed edge of A that appears reversed in B — the signature
        // of two pieces sharing a wall with consistent winding.
        let found: { indexA: number; indexB: number } | null = null;
        for (let i = 0; i < ringA.length && !found; i += 1) {
          const from = ringA[i]!;
          const to = ringA[(i + 1) % ringA.length]!;
          for (let j = 0; j < ringB.length; j += 1) {
            if (ringB[j] === to && ringB[(j + 1) % ringB.length] === from) {
              found = { indexA: i, indexB: j };
              break;
            }
          }
        }
        if (!found) continue;

        // Splice B into A along the shared edge.
        const union: number[] = [];
        for (let i = 1; i <= ringA.length; i += 1) {
          union.push(ringA[(found.indexA + i) % ringA.length]!);
        }
        union.pop();
        for (let j = 1; j <= ringB.length; j += 1) {
          union.push(ringB[(found.indexB + j) % ringB.length]!);
        }
        union.pop();

        if (!isConvex(ringCoords(union))) continue;

        pieces[a] = union;
        pieces[b] = null;
        merged = true;
        break;
      }
    }
  }

  return pieces.filter((ring): ring is number[] => ring !== null);
}

/** Triangulate one shape into flat `[x, y]` vertex pairs, three per triangle. */
function trianglesForShape(shape: Shape): number[] {
  const vertices: number[] = [...shape.outer.points];
  const holeStarts: number[] = [];
  for (const hole of shape.holes) {
    holeStarts.push(vertices.length / 2);
    vertices.push(...hole.points);
  }

  const mesh: number[] = [];
  for (const index of earcut(vertices, holeStarts)) {
    mesh.push(vertices[index * 2]!, vertices[index * 2 + 1]!);
  }
  return mesh;
}

/** Triangulate one shape and merge the result into convex hulls. */
function hullsForShape(shape: Shape): {
  hulls: Float32Array[];
  triangles: number;
  mesh: number[];
} {
  const vertices: number[] = [...shape.outer.points];
  const holeStarts: number[] = [];
  for (const hole of shape.holes) {
    holeStarts.push(vertices.length / 2);
    vertices.push(...hole.points);
  }

  const triangles = earcut(vertices, holeStarts);
  if (triangles.length === 0) return { hulls: [], triangles: 0, mesh: [] };

  const mesh: number[] = [];
  for (const index of triangles) {
    mesh.push(vertices[index * 2]!, vertices[index * 2 + 1]!);
  }

  const hulls = mergeIntoConvexPieces(vertices, triangles).map((ring) => {
    const out = new Float32Array(ring.length * 2);
    for (let i = 0; i < ring.length; i += 1) {
      out[i * 2] = vertices[ring[i]! * 2]!;
      out[i * 2 + 1] = vertices[ring[i]! * 2 + 1]!;
    }
    return out;
  });
  return { hulls, triangles: triangles.length / 3, mesh };
}

// --- Source -----------------------------------------------------------------

/**
 * Snap axes to the cache quantum.
 *
 * Geometry is built at these values, not at the raw ones, so what a cache key
 * promises is exactly what was built. Interpolating at the raw axes instead
 * would mean the first caller to miss the cache decides what every later
 * caller with a near-identical request receives.
 */
function quantizeAxes(axes: FontAxes): FontAxes {
  return {
    wght: Math.round(axes.wght / AXIS_CACHE_QUANTUM) * AXIS_CACHE_QUANTUM,
    wdth: Math.round(axes.wdth / AXIS_CACHE_QUANTUM) * AXIS_CACHE_QUANTUM,
  };
}

function axisKey(axes: FontAxes): string {
  const snapped = quantizeAxes(axes);
  return `${String(snapped.wght)}:${String(snapped.wdth)}`;
}

/** One baked entry: a character or a ligature, across the axis grid. */
interface BakedEntry {
  readonly commands: Uint8Array;
  readonly coordinateCount: number;
  /**
   * `[advance, ...coordinates]` per axis sample, row-major. Sample 0 is
   * absolute; every later sample is a *difference* from sample 0, which is how
   * the bake keeps the file compressible.
   */
  readonly rows: Int16Array;
  readonly sampleCount: number;
}

interface BakedOutlines {
  readonly unitsPerEm: number;
  readonly weights: number[];
  readonly widths: number[];
  readonly entries: Map<string, BakedEntry>;
  /** Longest ligature in the table, so matching knows how far to look ahead. */
  readonly longestSequence: number;
}

/** Parse `glyph-outlines.bin`. See `scripts/build-glyph-outlines.ts` for the format. */
function decodeOutlines(buffer: ArrayBuffer): BakedOutlines {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== OUTLINE_MAGIC) {
    throw new Error("Drift: glyph-outlines.bin is not a Drift outline file.");
  }
  const version = view.getUint16(4, true);
  if (version !== OUTLINE_VERSION) {
    throw new Error(
      `Drift: glyph-outlines.bin is version ${String(version)}, expected ${String(OUTLINE_VERSION)}. ` +
        `Re-run \`pnpm bake:glyphs\`.`,
    );
  }

  const unitsPerEm = view.getUint16(6, true);
  const weightCount = view.getUint16(8, true);
  const widthCount = view.getUint16(10, true);
  const entryCount = view.getUint16(12, true);

  let offset = 14;
  const weights: number[] = [];
  const widths: number[] = [];
  for (let i = 0; i < weightCount; i += 1, offset += 2) {
    weights.push(view.getUint16(offset, true));
  }
  for (let i = 0; i < widthCount; i += 1, offset += 2) {
    widths.push(view.getUint16(offset, true));
  }

  const entries = new Map<string, BakedEntry>();
  let longestSequence = 1;
  const decoder = new TextDecoder("ascii");

  for (let index = 0; index < entryCount; index += 1) {
    const sequenceLength = view.getUint8(offset);
    const commandCount = view.getUint16(offset + 1, true);
    const coordinateCount = view.getUint16(offset + 3, true);
    const sampleCount = view.getUint16(offset + 5, true);
    offset += 7;

    const sequence = decoder.decode(
      new Uint8Array(buffer, offset, sequenceLength),
    );
    offset += sequenceLength;

    const commands = new Uint8Array(buffer, offset, commandCount);
    offset += commandCount;

    const rowWidth = coordinateCount + 1;
    // `Int16Array` over the buffer needs 2-byte alignment, which the variable
    // command and sequence lengths do not guarantee. Copying is a few hundred
    // kilobytes once at load, against a misalignment that throws.
    const rows = new Int16Array(sampleCount * rowWidth);
    for (let i = 0; i < rows.length; i += 1) {
      rows[i] = view.getInt16(offset + i * 2, true);
    }
    offset += rows.length * 2;

    entries.set(sequence, { commands, coordinateCount, rows, sampleCount });
    longestSequence = Math.max(longestSequence, sequenceLength);
  }

  return { unitsPerEm, weights, widths, entries, longestSequence };
}

/** Index of the sample below `at`, and how far between it and the next one. */
function bracket(values: readonly number[], at: number): [number, number] {
  let upper = 1;
  while (upper < values.length - 1 && values[upper]! < at) upper += 1;
  const span = values[upper]! - values[upper - 1]!;
  const t = span === 0 ? 0 : (at - values[upper - 1]!) / span;
  return [upper - 1, Math.max(0, Math.min(1, t))];
}

/**
 * Load the baked outlines and return a handle that turns words into geometry.
 *
 * Throws if the file cannot be fetched or parsed — there is no meaningful
 * fallback, since a word with no outlines is not a body.
 */
export async function loadGlyphSource(
  url: string = outlinesUrl,
): Promise<GlyphSource> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Drift: glyph outline fetch failed with ${String(response.status)}.`,
    );
  }
  const baked = decodeOutlines(await response.arrayBuffer());

  /**
   * Interpolate one entry to the given axes.
   *
   * Bilinear over the sample grid, which is exact rather than approximate:
   * Archivo's design space is linear between masters and the bake samples the
   * masters, so this reproduces `getVariation` to within its own integer
   * rounding — measured at 2.33 font units, 0.0023 em.
   */
  function coordinatesAt(entry: BakedEntry, axes: FontAxes): Float32Array {
    const rowWidth = entry.coordinateCount + 1;
    const out = new Float32Array(rowWidth);

    // A single-sample entry is one the bake found not point-compatible; it is
    // used as-is at every axis value.
    if (entry.sampleCount === 1) {
      for (let i = 0; i < rowWidth; i += 1) out[i] = entry.rows[i]!;
      return out;
    }

    const [w0, wt] = bracket(baked.weights, axes.wght);
    const [d0, dt] = bracket(baked.widths, axes.wdth);
    const widthCount = baked.widths.length;
    const corner = (wi: number, di: number): number =>
      (wi * widthCount + di) * rowWidth;

    const a = corner(w0, d0);
    const b = corner(w0 + 1, d0);
    const c = corner(w0, d0 + 1);
    const d = corner(w0 + 1, d0 + 1);

    // Samples past the first are stored as differences from sample 0, so every
    // corner is reconstituted before it is blended. Sample 0 is the one row
    // that is already absolute and must not have itself added to it.
    const value = (row: number, i: number): number =>
      row === 0 ? entry.rows[i]! : entry.rows[i]! + entry.rows[row + i]!;

    for (let i = 0; i < rowWidth; i += 1) {
      const va = value(a, i);
      const vb = value(b, i);
      const vc = value(c, i);
      const vd = value(d, i);
      const low = va + (vb - va) * wt;
      const high = vc + (vd - vc) * wt;
      out[i] = low + (high - low) * dt;
    }
    return out;
  }

  /**
   * Split a word into baked entries, preferring the longest match.
   *
   * This is the whole of the shaping that survives dropping fontkit, and it is
   * enough because the only substitutions Archivo applies by default are five
   * `f`-ligatures — verified by enumerating every printable-ASCII pair and
   * triple at bake time. Characters with no entry are skipped rather than
   * substituted with a notdef box: a stray glyph the visitor cannot explain is
   * worse than a missing one.
   */
  function entriesForWord(word: string): BakedEntry[] {
    const found: BakedEntry[] = [];
    let index = 0;
    while (index < word.length) {
      let matched: BakedEntry | undefined;
      let length = Math.min(baked.longestSequence, word.length - index);
      for (; length >= 1; length -= 1) {
        matched = baked.entries.get(word.slice(index, index + length));
        if (matched) break;
      }
      if (matched) {
        found.push(matched);
        index += length;
      } else {
        index += 1;
      }
    }
    return found;
  }

  /**
   * Lay a word out and return its contours, centred on their own bounding box.
   *
   * Centred rather than sitting on the baseline at the typographic origin: a
   * body must rotate about something that looks like its middle, or it reads as
   * swinging from a hinge at its bottom-left corner.
   */
  function contoursForWord(
    word: string,
    axes: FontAxes,
    tolerance: number,
  ): {
    contours: Contour[];
    path: WordPath;
    width: number;
    height: number;
  } {
    const scale = 1 / baked.unitsPerEm;
    const snapped = quantizeAxes(axes);

    const contours: Contour[] = [];
    // The same outline a second time, unflattened. Built alongside rather than
    // in a separate pass so both share one pen position and one centring —
    // recomputing the layout for the drawn copy would risk the picture and the
    // body disagreeing by a rounding error nobody could see but everyone would
    // feel on contact.
    const pathCommands: number[] = [];
    const pathCoordinates: number[] = [];

    let penX = 0;
    for (const entry of entriesForWord(word)) {
      const row = coordinatesAt(entry, snapped);
      const coordinates = row.subarray(1);
      const offsetX = penX * scale;
      contours.push(
        ...contoursForEntry(
          entry.commands,
          coordinates,
          offsetX,
          scale,
          tolerance,
        ),
      );

      let read = 0;
      for (const command of entry.commands) {
        pathCommands.push(command);
        const pairs =
          command === COMMAND_QUADRATIC_TO
            ? 2
            : command === COMMAND_CLOSE_PATH
              ? 0
              : 1;
        for (let pair = 0; pair < pairs; pair += 1) {
          pathCoordinates.push(
            coordinates[read]! * scale + offsetX,
            coordinates[read + 1]! * scale,
          );
          read += 2;
        }
      }
      penX += row[0]!;
    }

    const emptyPath: WordPath = {
      commands: new Uint8Array(0),
      coordinates: new Float32Array(0),
    };
    if (contours.length === 0) {
      return { contours, path: emptyPath, width: 0, height: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
      for (let i = 0; i < contour.points.length; i += 2) {
        minX = Math.min(minX, contour.points[i]!);
        maxX = Math.max(maxX, contour.points[i]!);
        minY = Math.min(minY, contour.points[i + 1]!);
        maxY = Math.max(maxY, contour.points[i + 1]!);
      }
    }

    // The bounding box comes from the *flattened* contours, and the curves are
    // shifted by that same centre rather than by one of their own. A quadratic's
    // control point can sit outside the curve it describes, so a box fitted to
    // the raw path would be slightly larger and would put the drawn word a
    // fraction off the body it belongs to.
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    for (const contour of contours) {
      for (let i = 0; i < contour.points.length; i += 2) {
        contour.points[i] = contour.points[i]! - centreX;
        contour.points[i + 1] = contour.points[i + 1]! - centreY;
      }
    }
    for (let i = 0; i < pathCoordinates.length; i += 2) {
      pathCoordinates[i] = pathCoordinates[i]! - centreX;
      pathCoordinates[i + 1] = pathCoordinates[i + 1]! - centreY;
    }

    return {
      contours,
      path: {
        commands: Uint8Array.from(pathCommands),
        coordinates: Float32Array.from(pathCoordinates),
      },
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  const geometries = new Map<string, WordGeometry>();
  const outlines = new Map<string, WordOutline>();

  return {
    advanceFor(word: string, axes: FontAxes): number {
      const snapped = quantizeAxes(axes);
      let total = 0;
      for (const entry of entriesForWord(word)) {
        // Only the advance is needed, and it is the first number in the row —
        // but the row is interpolated whole, since the corners have to be
        // reconstituted from their deltas either way.
        total += coordinatesAt(entry, snapped)[0]!;
      }
      return total / baked.unitsPerEm;
    },

    outlineFor(
      word: string,
      axes: FontAxes,
      tolerance: number = FLATTEN_TOLERANCE_EM,
    ): WordOutline {
      const key = `${axisKey(axes)}|${String(tolerance)}|${word}`;
      const cached = outlines.get(key);
      if (cached) return cached;

      const { contours, path, width, height } = contoursForWord(
        word,
        axes,
        tolerance,
      );
      const mesh: number[] = [];
      for (const shape of groupIntoShapes(contours)) {
        mesh.push(...trianglesForShape(shape));
      }

      const outline: WordOutline = {
        triangles: Float32Array.from(mesh),
        path,
        width,
        height,
      };
      outlines.set(key, outline);
      return outline;
    },

    geometryFor(
      word: string,
      axes: FontAxes,
      tolerance: number = FLATTEN_TOLERANCE_EM,
    ): WordGeometry {
      const key = `${axisKey(axes)}|${String(tolerance)}|${word}`;
      const cached = geometries.get(key);
      if (cached) return cached;

      const { contours, path, width, height } = contoursForWord(
        word,
        axes,
        tolerance,
      );
      const hulls: Float32Array[] = [];
      const mesh: number[] = [];
      let triangleCount = 0;
      for (const shape of groupIntoShapes(contours)) {
        const decomposed = hullsForShape(shape);
        hulls.push(...decomposed.hulls);
        mesh.push(...decomposed.mesh);
        triangleCount += decomposed.triangles;
      }

      const geometry: WordGeometry = {
        hulls,
        contours: contours.map((c) => Float32Array.from(c.points)),
        triangles: Float32Array.from(mesh),
        triangleCount,
        path,
        width,
        height,
      };
      geometries.set(key, geometry);
      return geometry;
    },
  };
}
