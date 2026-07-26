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
