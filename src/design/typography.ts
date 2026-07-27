/**
 * Type constants and the mapping from model scores to variable font axes.
 *
 * This is the "the word IS the body" wiring: a word predicted heavy renders
 * heavy, a word predicted intense renders wide. Both ranges come from
 * `DESIGN.md` and belong here rather than at their use sites, because they are
 * design decisions rather than implementation details.
 */

import type { PropertyScores } from "../ml/properties";

/**
 * The display face is Archivo, variable across `wght` 100–900 and `wdth`
 * 62–125 — but nothing at runtime loads it any more. Phase 2.5 moved outline
 * extraction to build time, so `public/fonts/Archivo.ttf` is now an input to
 * `scripts/build-glyph-outlines.ts` rather than something a visitor downloads.
 * The ranges the piece actually uses are the two constants below, and they are
 * what that script samples.
 */

/**
 * What an uncommitted word renders at, per `DESIGN.md` — the neutral values the
 * commit spring departs from once the model has an opinion.
 */
export const NEUTRAL_AXES = { wght: 500, wdth: 100 } as const;

/**
 * `wght` from `mass`. The 300–800 range is narrower than Archivo's 100–900:
 * the extremes are display weights that stop reading as the same typeface, and
 * a room of words should look like one family under different loads.
 */
const WEIGHT_AT_LIGHTEST = 300;
const WEIGHT_AT_HEAVIEST = 800;

/**
 * `wdth` from `intensity`. Deliberately asymmetric around the neutral 100 —
 * Archivo's narrow end gets spindly fast, and a quiet word should read as
 * quiet, not as condensed.
 */
const WIDTH_AT_QUIETEST = 85;
const WIDTH_AT_LOUDEST = 125;

/**
 * Wear: what the `age` score does to a letterform.
 *
 * `age` was the one property the model predicts that nothing consumed — open
 * since Phase 1a. Old words now render very slightly eaten away and softer at
 * the boundary, as though they have been sitting in the paper longer.
 *
 * It costs nothing, which is why it is possible at all: the glyph is drawn from
 * a distance field, so eroding it is a shift in where the field is thresholded
 * rather than a different outline. There is no re-bake, no second texture and
 * no geometry change — the same reason the commit spring drives uniforms only.
 *
 * This does **not** collide with Phase 6's ancient-words behaviour. That is a
 * momentary sepia flash at commit on a curated list of about thirty words; this
 * is a permanent material property of every word the model rates old.
 *
 * Both values are small on purpose. `DESIGN.md` requires the room read as one
 * typeface at a glance, and a heavy erosion would read as a second, blurrier
 * font mixed in.
 *
 * `EDGE_EROSION_AT_OLDEST` is in field units, where the whole field spans 1.0
 * across `2 × SPREAD_EM`; `EDGE_WEAR_AT_OLDEST` multiplies the edge softness,
 * so 0.6 means the oldest word's edge is 60% softer than a new one's.
 */
export const EDGE_EROSION_AT_OLDEST = 0.012;
export const EDGE_WEAR_AT_OLDEST = 0.6;

/** `age` in [-1, 1] mapped to a 0–1 wear amount. */
export function wearForAge(age: number): number {
  return (Math.max(-1, Math.min(1, age)) + 1) / 2;
}

export interface FontAxes {
  readonly wght: number;
  readonly wdth: number;
}

/** Map a score in [-1, 1] onto an axis range. */
function axisFromScore(
  score: number,
  atMinusOne: number,
  atPlusOne: number,
): number {
  const t = (Math.max(-1, Math.min(1, score)) + 1) / 2;
  return atMinusOne + t * (atPlusOne - atMinusOne);
}

/** The variable font axes a word should render at, given what the model thinks of it. */
export function axesForScores(scores: PropertyScores): FontAxes {
  return {
    wght: axisFromScore(scores.mass, WEIGHT_AT_LIGHTEST, WEIGHT_AT_HEAVIEST),
    wdth: axisFromScore(scores.intensity, WIDTH_AT_QUIETEST, WIDTH_AT_LOUDEST),
  };
}
