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

/**
 * Shadow blur and drop, in em, across the mass range.
 *
 * Both are bounded by the distance field's own reach: the shadow is read out of
 * the same texture as the ink, and that field only knows distances up to
 * `SPREAD_EM` beyond the glyph. The blur ramps from the letter's edge outward by
 * twice these values, so the heaviest must stay under half the spread or the
 * shadow would be sliced off square at the quad's edge.
 *
 * A heavy word casts a wider, further-dropped shadow — it reads as sitting
 * above the paper with weight behind it — where a light word's is tight and
 * close, barely detached. This is the same mass score driving `wght`, so the
 * shadow and the letterform thicken together.
 */
export const SHADOW_BLUR_EM_LIGHTEST = 0.022;
export const SHADOW_BLUR_EM_HEAVIEST = 0.065;
export const SHADOW_DROP_EM_LIGHTEST = 0.014;
export const SHADOW_DROP_EM_HEAVIEST = 0.055;

/**
 * Ink for a word, interpolated by its `warmth` score.
 *
 * Per DESIGN.md this runs `INK_COOLEST` → `INK` → `INK_WARMEST` across
 * warmth −1 → 0 → +1, and must stay subtle enough that the room reads as
 * monochrome at a glance. Two segments rather than one, so a neutral word lands
 * exactly on `INK` rather than somewhere between the extremes.
 *
 * Returns linear 0–1 components, which is what the shader wants.
 */
export function inkForWarmth(warmth: number): [number, number, number] {
  const clamped = Math.max(-1, Math.min(1, warmth));
  const from = clamped < 0 ? INK_COOLEST : INK;
  const to = clamped < 0 ? INK : INK_WARMEST;
  const t = clamped < 0 ? clamped + 1 : clamped;

  const channel = (hex: string, index: number): number =>
    parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;

  return [
    channel(from, 0) + (channel(to, 0) - channel(from, 0)) * t,
    channel(from, 1) + (channel(to, 1) - channel(from, 1)) * t,
    channel(from, 2) + (channel(to, 2) - channel(from, 2)) * t,
  ];
}

/** Procedural background grain, per DESIGN.md. */
export const GRAIN_OPACITY = 0.02;
