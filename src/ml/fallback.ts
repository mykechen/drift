/**
 * What a word gets when the model is not available.
 *
 * This is not the out-of-vocabulary path — that lives inside the model itself,
 * as the character branch, and every string including nonsense goes through it.
 * This is the harder failure: ONNX Runtime never loaded at all, because the
 * WebAssembly fetch failed or the runtime is blocked. The piece must still
 * accept typing in that case; a room where words refuse to fall is broken in a
 * way a room where every word weighs the same is not.
 *
 * Every axis is zero — the exact midpoint each axis is defined around. A word
 * with these scores is neither heavy nor light, neither warm nor cool. It falls
 * plainly. DESIGN.md's brief for unknown input is "light, drifty, unstable",
 * but that describes a word the model *did* score; a word the model never saw
 * should not be characterised at all, and the honest value is the middle.
 */

import type { PropertyScores } from "./properties";

export const NEUTRAL_SCORES: PropertyScores = Object.freeze({
  mass: 0,
  drag: 0,
  restitution: 0,
  warmth: 0,
  age: 0,
  intensity: 0,
});
