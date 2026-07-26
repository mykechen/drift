/**
 * Words into signed distance fields.
 *
 * The room draws every word from an SDF rather than from its own triangulation.
 * That is what buys crisp curves at any scale — the still export renders at 2×,
 * and a word being drawn from the same coarse polygons its colliders were cut
 * from would show its facets there.
 *
 * **One field per word, generated on commit.** The alternative — a glyph atlas
 * baked per axis sample — does not survive this piece's premise: `wght` and
 * `wdth` move per word, a rasterised field cannot be interpolated across a
 * shape change the way an outline can, and an atlas covering the axis grid
 * would put back a large share of the payload Phase 2.5 just removed. A word is
 * small (a few hundred texels), it is generated once, and it is cached by word
 * and quantised axes exactly as its hulls already are.
 *
 * **The browser rasterises the curves.** `Path2D` takes the baked quadratics
 * directly, fills them with the nonzero winding rule — which is what makes a
 * counter a hole — and does it in native code. Writing a scanline rasteriser
 * here would be slower, longer, and worse at the one thing that matters, which
 * is being exactly right about what is inside the letter.
 */

import {
  PATH_CLOSE,
  PATH_LINE_TO,
  PATH_MOVE_TO,
  PATH_QUADRATIC_TO,
  type WordPath,
} from "./glyphs";

/**
 * Texels per em in the generated field.
 *
 * A word stands roughly 0.73 em tall and is drawn about 36px per em on a 900px
 * canvas, so this is a comfortable oversample at native size and still has
 * headroom for the 2× export. It is the resolution of the *distance* function,
 * not of the edge: an SDF stays crisp well past its own texel grid, which is
 * the entire reason for using one.
 */
const TEXELS_PER_EM = 64;

/**
 * How far the field reaches beyond the ink, in em.
 *
 * The shader needs distance on both sides of the edge to antialias, and later
 * phases need more of it than that — DESIGN.md's shadow is a blurred offset of
 * this same silhouette, and reading it out of the field costs nothing if the
 * range is there. Too wide wastes texels on empty paper; this is about two
 * pixels at native size and forty at the largest sane zoom.
 */
export const SPREAD_EM = 0.08;

/**
 * Supersampling factor for the mask the distance transform runs on.
 *
 * The transform measures in whole mask texels, so its precision is the mask's
 * resolution, not the field's. Rasterising finer and dividing the result buys
 * sub-texel precision.
 *
 * Two, not four. The transform is the entire cost of a bake and it scales with
 * the *area* of the mask, so 4× supersampling costs four times what 2× does —
 * measured at 97ms a word against 7ms. What it buys is precision of 1/8 em-texel
 * versus 1/4, which is 0.002 em versus 0.004 em, against a field whose texels
 * are 0.016 em apart and an edge the shader softens over a whole screen pixel.
 * Nobody can see the difference and everybody would feel the stall.
 */
const MASK_SUPERSAMPLE = 2;

export interface SdfField {
  /** Single-channel distance, row-major, top row first. */
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Size of the field in em, including the spread margin on all sides. */
  readonly emWidth: number;
  readonly emHeight: number;
}

export interface SdfBaker {
  /** Build a field for one word. Callers cache; this always does the work. */
  bake(path: WordPath, emWidth: number, emHeight: number): SdfField | null;
}

/** A large-but-finite starting distance, in mask texels. */
const FAR = 1e9;

/**
 * 8-point signed sequential Euclidean distance transform.
 *
 * Each cell carries the offset to the nearest edge cell rather than a scalar,
 * so distances stay Euclidean rather than becoming the chessboard approximation
 * a naive two-pass transform produces. Run once over the inside and once over
 * the outside; the signed distance is the difference.
 *
 * `dx`/`dy` are the working offset grids, reused across calls to keep this off
 * the allocator during a commit.
 */
function transform(
  dx: Float32Array,
  dy: Float32Array,
  width: number,
  height: number,
): void {
  // The neighbour comparison is written out rather than factored into a helper.
  // It runs on the order of ten million times per bake, and the readable version
  // — a closure over `dx`/`dy` taking an offset — measured slower by enough to
  // matter. This is the one place in the file where that trade is worth making.
  let best: number;
  let candidateX: number;
  let candidateY: number;
  let other: number;

  // Forward pass: north-west neighbours, then the cell to the left.
  for (let y = 1; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      best = dx[index]! * dx[index]! + dy[index]! * dy[index]!;

      if (x > 0) {
        other = index - width - 1;
        candidateX = dx[other]! + 1;
        candidateY = dy[other]! + 1;
        const d = candidateX * candidateX + candidateY * candidateY;
        if (d < best) {
          best = d;
          dx[index] = candidateX;
          dy[index] = candidateY;
        }
      }

      other = index - width;
      candidateX = dx[other]!;
      candidateY = dy[other]! + 1;
      const straight = candidateX * candidateX + candidateY * candidateY;
      if (straight < best) {
        best = straight;
        dx[index] = candidateX;
        dy[index] = candidateY;
      }

      if (x + 1 < width) {
        other = index - width + 1;
        candidateX = dx[other]! - 1;
        candidateY = dy[other]! + 1;
        const d = candidateX * candidateX + candidateY * candidateY;
        if (d < best) {
          // Last comparison in the pass; `best` is not read again.
          dx[index] = candidateX;
          dy[index] = candidateY;
        }
      }
    }
    for (let x = 1; x < width; x += 1) {
      const index = row + x;
      other = index - 1;
      candidateX = dx[other]! + 1;
      candidateY = dy[other]!;
      if (
        candidateX * candidateX + candidateY * candidateY <
        dx[index]! * dx[index]! + dy[index]! * dy[index]!
      ) {
        dx[index] = candidateX;
        dy[index] = candidateY;
      }
    }
  }

  // Backward pass: south-east neighbours, then the cell to the right.
  for (let y = height - 2; y >= 0; y -= 1) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = row + x;
      best = dx[index]! * dx[index]! + dy[index]! * dy[index]!;

      if (x + 1 < width) {
        other = index + width + 1;
        candidateX = dx[other]! - 1;
        candidateY = dy[other]! - 1;
        const d = candidateX * candidateX + candidateY * candidateY;
        if (d < best) {
          best = d;
          dx[index] = candidateX;
          dy[index] = candidateY;
        }
      }

      other = index + width;
      candidateX = dx[other]!;
      candidateY = dy[other]! - 1;
      const straight = candidateX * candidateX + candidateY * candidateY;
      if (straight < best) {
        best = straight;
        dx[index] = candidateX;
        dy[index] = candidateY;
      }

      if (x > 0) {
        other = index + width - 1;
        candidateX = dx[other]! + 1;
        candidateY = dy[other]! - 1;
        const d = candidateX * candidateX + candidateY * candidateY;
        if (d < best) {
          // Last comparison in the pass; `best` is not read again.
          dx[index] = candidateX;
          dy[index] = candidateY;
        }
      }
    }
    for (let x = width - 2; x >= 0; x -= 1) {
      const index = row + x;
      other = index + 1;
      candidateX = dx[other]! - 1;
      candidateY = dy[other]!;
      if (
        candidateX * candidateX + candidateY * candidateY <
        dx[index]! * dx[index]! + dy[index]! * dy[index]!
      ) {
        dx[index] = candidateX;
        dy[index] = candidateY;
      }
    }
  }
}

/** Replay a `WordPath` into a `Path2D`, in mask-texel coordinates. */
function toPath2D(
  path: WordPath,
  originX: number,
  originY: number,
  scale: number,
): Path2D {
  const shape = new Path2D();
  const at = path.coordinates;
  let read = 0;

  // y is negated: font space grows upward, canvas space grows downward.
  const px = (index: number): number => at[index]! * scale + originX;
  const py = (index: number): number => -at[index]! * scale + originY;

  for (const command of path.commands) {
    switch (command) {
      case PATH_MOVE_TO:
        shape.moveTo(px(read), py(read + 1));
        read += 2;
        break;
      case PATH_LINE_TO:
        shape.lineTo(px(read), py(read + 1));
        read += 2;
        break;
      case PATH_QUADRATIC_TO:
        shape.quadraticCurveTo(
          px(read),
          py(read + 1),
          px(read + 2),
          py(read + 3),
        );
        read += 4;
        break;
      case PATH_CLOSE:
        shape.closePath();
        break;
    }
  }
  return shape;
}

/**
 * Create a baker. Holds one canvas and grows its working buffers as needed,
 * because a commit should not be allocating four bitmaps.
 */
export function createSdfBaker(): SdfBaker {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  let insideX = new Float32Array(0);
  let insideY = new Float32Array(0);
  let outsideX = new Float32Array(0);
  let outsideY = new Float32Array(0);

  return {
    bake(path: WordPath, emWidth: number, emHeight: number): SdfField | null {
      if (!context || path.commands.length === 0) return null;

      const fieldWidth = Math.ceil((emWidth + SPREAD_EM * 2) * TEXELS_PER_EM);
      const fieldHeight = Math.ceil((emHeight + SPREAD_EM * 2) * TEXELS_PER_EM);
      if (fieldWidth <= 0 || fieldHeight <= 0) return null;

      const maskWidth = fieldWidth * MASK_SUPERSAMPLE;
      const maskHeight = fieldHeight * MASK_SUPERSAMPLE;
      const maskScale = TEXELS_PER_EM * MASK_SUPERSAMPLE;

      // Grow-only, and never shrunk. Assigning to `canvas.width` reallocates
      // the backing bitmap and resets the whole 2D state, and doing it on every
      // bake was most of the cost of a long word — 26ms for `extraordinary`
      // against 8ms once the canvas is reused. The rasterised word occupies the
      // top-left corner of whatever size the canvas has grown to; only that
      // rectangle is ever cleared or read back.
      if (canvas.width < maskWidth || canvas.height < maskHeight) {
        canvas.width = Math.max(canvas.width, maskWidth);
        canvas.height = Math.max(canvas.height, maskHeight);
      }
      context.clearRect(0, 0, maskWidth, maskHeight);
      context.fillStyle = "#fff";
      // The path is centred on its own bounding box, so the mask's centre is
      // where the origin goes.
      context.fill(
        toPath2D(path, maskWidth / 2, maskHeight / 2, maskScale),
        "nonzero",
      );

      const pixels = context.getImageData(0, 0, maskWidth, maskHeight).data;
      const cells = maskWidth * maskHeight;
      if (insideX.length < cells) {
        insideX = new Float32Array(cells);
        insideY = new Float32Array(cells);
        outsideX = new Float32Array(cells);
        outsideY = new Float32Array(cells);
      }

      // Seed both grids from coverage. A texel more than half covered is
      // inside; the two grids are each other's complement, so an edge in one is
      // a zero-distance cell and everything else starts unreachably far away.
      for (let index = 0; index < cells; index += 1) {
        const covered = pixels[index * 4 + 3]! > 127;
        insideX[index] = covered ? 0 : FAR;
        insideY[index] = covered ? 0 : FAR;
        outsideX[index] = covered ? FAR : 0;
        outsideY[index] = covered ? FAR : 0;
      }

      transform(insideX, insideY, maskWidth, maskHeight);
      transform(outsideX, outsideY, maskWidth, maskHeight);

      const spreadInMaskTexels = SPREAD_EM * maskScale;
      const data = new Uint8Array(fieldWidth * fieldHeight);
      for (let y = 0; y < fieldHeight; y += 1) {
        // Sample the centre of each field texel's block of mask texels.
        const maskY = Math.min(
          maskHeight - 1,
          y * MASK_SUPERSAMPLE + (MASK_SUPERSAMPLE >> 1),
        );
        for (let x = 0; x < fieldWidth; x += 1) {
          const maskX = Math.min(
            maskWidth - 1,
            x * MASK_SUPERSAMPLE + (MASK_SUPERSAMPLE >> 1),
          );
          const index = maskY * maskWidth + maskX;
          // Positive inside the letter, negative outside, in mask texels.
          const signed =
            Math.sqrt(outsideX[index]! ** 2 + outsideY[index]! ** 2) -
            Math.sqrt(insideX[index]! ** 2 + insideY[index]! ** 2);
          // 0.5 is the edge, which is what the shader thresholds against.
          const normalized = 0.5 + signed / (2 * spreadInMaskTexels);
          data[y * fieldWidth + x] = Math.max(
            0,
            Math.min(255, Math.round(normalized * 255)),
          );
        }
      }

      return {
        data,
        width: fieldWidth,
        height: fieldHeight,
        emWidth: fieldWidth / TEXELS_PER_EM,
        emHeight: fieldHeight / TEXELS_PER_EM,
      };
    },
  };
}
