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
 */

import * as fontkit from "fontkit";
import earcut from "earcut";
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
 */
export const FLATTEN_TOLERANCE_EM = 1 / 32;

/** Guard against a pathological curve subdividing without bound. */
const MAX_SEGMENTS_PER_CURVE = 16;

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
  /** Triangles earcut produced before convex merging. Diagnostic only. */
  readonly triangleCount: number;
  /** Bounding box of the whole word, em units. */
  readonly width: number;
  readonly height: number;
}

export interface GlyphSource {
  /**
   * Geometry for a word at given axis values. Cached per word, axis pair and
   * tolerance. `tolerance` exists so /debug/glyphs can sweep it; the piece
   * always uses the default.
   */
  geometryFor(word: string, axes: FontAxes, tolerance?: number): WordGeometry;
  /** Advance width of a word in em units, without building geometry. */
  advanceFor(word: string, axes: FontAxes): number;
}

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

/** Flatten one glyph's path into closed polygonal contours, offset into place. */
function contoursForGlyph(
  glyph: fontkit.Glyph,
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

  for (const command of glyph.path.commands) {
    const args = command.args;
    switch (command.command) {
      case "moveTo": {
        finish();
        cursorX = args[0]!;
        cursorY = args[1]!;
        push(cursorX, cursorY);
        break;
      }
      case "lineTo": {
        cursorX = args[0]!;
        cursorY = args[1]!;
        push(cursorX, cursorY);
        break;
      }
      case "quadraticCurveTo": {
        const [cx, cy, x1, y1] = args as [number, number, number, number];
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
      case "bezierCurveTo": {
        // Archivo is TrueType and never emits these, but a future face might.
        const [c1x, c1y, c2x, c2y, x1, y1] = args as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        for (let step = 1; step <= MAX_SEGMENTS_PER_CURVE; step += 1) {
          const t = step / MAX_SEGMENTS_PER_CURVE;
          const inv = 1 - t;
          push(
            inv ** 3 * cursorX +
              3 * inv * inv * t * c1x +
              3 * inv * t * t * c2x +
              t ** 3 * x1,
            inv ** 3 * cursorY +
              3 * inv * inv * t * c1y +
              3 * inv * t * t * c2y +
              t ** 3 * y1,
          );
        }
        cursorX = x1;
        cursorY = y1;
        break;
      }
      case "closePath": {
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

/** Triangulate one shape and merge the result into convex hulls. */
function hullsForShape(shape: Shape): {
  hulls: Float32Array[];
  triangles: number;
} {
  const vertices: number[] = [...shape.outer.points];
  const holeStarts: number[] = [];
  for (const hole of shape.holes) {
    holeStarts.push(vertices.length / 2);
    vertices.push(...hole.points);
  }

  const triangles = earcut(vertices, holeStarts);
  if (triangles.length === 0) return { hulls: [], triangles: 0 };

  const hulls = mergeIntoConvexPieces(vertices, triangles).map((ring) => {
    const out = new Float32Array(ring.length * 2);
    for (let i = 0; i < ring.length; i += 1) {
      out[i * 2] = vertices[ring[i]! * 2]!;
      out[i * 2 + 1] = vertices[ring[i]! * 2 + 1]!;
    }
    return out;
  });
  return { hulls, triangles: triangles.length / 3 };
}

// --- Source -----------------------------------------------------------------

function axisKey(axes: FontAxes): string {
  const wght = Math.round(axes.wght / AXIS_CACHE_QUANTUM) * AXIS_CACHE_QUANTUM;
  const wdth = Math.round(axes.wdth / AXIS_CACHE_QUANTUM) * AXIS_CACHE_QUANTUM;
  return `${String(wght)}:${String(wdth)}`;
}

/**
 * Load the display font and return a handle that turns words into geometry.
 *
 * Throws if the font cannot be fetched or parsed — there is no meaningful
 * fallback, since a word with no outlines is not a body.
 */
export async function loadGlyphSource(url: string): Promise<GlyphSource> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Drift: font fetch failed with ${String(response.status)}.`,
    );
  }
  // `@types/fontkit` describes the Node build, whose `create` takes a Buffer.
  // Vite resolves the package's browser entry, which reads a plain Uint8Array —
  // there is no Buffer in a browser and fontkit does not ship one. The cast is
  // the single point where the published types and the shipped build disagree;
  // it is checked by the fact that nothing downstream would work otherwise.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const base = fontkit.create(bytes as unknown as Buffer) as fontkit.Font;

  const variations = new Map<string, fontkit.Font>();
  function fontAt(axes: FontAxes): fontkit.Font {
    const key = axisKey(axes);
    let font = variations.get(key);
    if (!font) {
      // Read the quantised values back out of the key rather than off `axes`,
      // so the outlines built here are exactly the ones the key promises.
      const [wght, wdth] = key.split(":").map(Number) as [number, number];
      font = base.getVariation({ wght, wdth });
      variations.set(key, font);
    }
    return font;
  }

  const geometries = new Map<string, WordGeometry>();

  return {
    advanceFor(word: string, axes: FontAxes): number {
      const font = fontAt(axes);
      return font.layout(word).advanceWidth / font.unitsPerEm;
    },

    geometryFor(
      word: string,
      axes: FontAxes,
      tolerance: number = FLATTEN_TOLERANCE_EM,
    ): WordGeometry {
      const key = `${axisKey(axes)}|${String(tolerance)}|${word}`;
      const cached = geometries.get(key);
      if (cached) return cached;

      const font = fontAt(axes);
      const scale = 1 / font.unitsPerEm;
      const run = font.layout(word);

      const contours: Contour[] = [];
      let penX = 0;
      for (const glyph of run.glyphs) {
        contours.push(
          ...contoursForGlyph(glyph, penX * scale, scale, tolerance),
        );
        penX += glyph.advanceWidth;
      }

      // Centre on the bounding box so the body rotates about something that
      // looks like its middle, rather than about the typographic origin, which
      // sits on the baseline at the left edge and reads as a hinge.
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
      if (contours.length === 0) {
        const empty: WordGeometry = {
          hulls: [],
          contours: [],
          triangleCount: 0,
          width: 0,
          height: 0,
        };
        geometries.set(key, empty);
        return empty;
      }

      const centreX = (minX + maxX) / 2;
      const centreY = (minY + maxY) / 2;
      for (const contour of contours) {
        for (let i = 0; i < contour.points.length; i += 2) {
          contour.points[i] = contour.points[i]! - centreX;
          contour.points[i + 1] = contour.points[i + 1]! - centreY;
        }
      }

      const hulls: Float32Array[] = [];
      let triangleCount = 0;
      for (const shape of groupIntoShapes(contours)) {
        const decomposed = hullsForShape(shape);
        hulls.push(...decomposed.hulls);
        triangleCount += decomposed.triangles;
      }

      const geometry: WordGeometry = {
        hulls,
        contours: contours.map((c) => Float32Array.from(c.points)),
        triangleCount,
        width: maxX - minX,
        height: maxY - minY,
      };
      geometries.set(key, geometry);
      return geometry;
    },
  };
}
