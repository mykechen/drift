/**
 * The palette. Values are final and come from DESIGN.md — do not adjust them
 * here without changing that document first. No hex literal belongs anywhere
 * else in the source.
 *
 * The time-of-day shift and the warmth-driven ink interpolation are applied on
 * top of these base values; both land in Phase 3.
 */

/** Warm off-white. Paper. */
export const BACKGROUND = "#F4F0E8";

/** Near-black, warm. The default word. */
export const INK = "#1A1817";

/** Deep warm brown. Ink for words the model rates warmest (`warmth` = +1). */
export const INK_WARMEST = "#3A2418";

/** Deep cool blue-black. Ink for the coolest words (`warmth` = -1). */
export const INK_COOLEST = "#152838";

/** Deep coral-red. The text caret, and nothing else in the piece. */
export const ACCENT_CURSOR = "#D94F1E";

/** Cast beneath settled words. Blur radius scales with mass. */
export const SHADOW_COLOR = "#000000";
export const SHADOW_OPACITY = 0.08;

/** Procedural background grain, per DESIGN.md. */
export const GRAIN_OPACITY = 0.02;
