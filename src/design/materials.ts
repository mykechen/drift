/**
 * Animated materials — **an experiment, not a feature.**
 *
 * The question this exists to answer: a word is already drawn from its own
 * distance field, so its fill can be animated for the cost of a uniform. Does a
 * burning `ember` or a rippling `ocean` read as the word's *material*, or does
 * it read as a cheap effect stuck onto a typeface?
 *
 * It is built for exactly two words so it can be looked at and thrown away. Two
 * things to keep straight while judging it:
 *
 * **A curated list is right for an experiment and wrong for a feature.** Phase
 * 3.5's colour work is driven from scores across all 77,843 committable words,
 * precisely so the room does not read as "these few words are special". A
 * hard-coded pair contradicts that. If this survives, it has to become
 * score-driven — plausibly `intensity` against `warmth`, so anything hot enough
 * flickers — or it has to be declared a *special behaviour*, and `DESIGN.md`
 * caps those at six and already names six. There is no third option where a
 * two-word list quietly ships.
 *
 * **It costs the room its stillness in a way the breath does not.** The breath
 * is physics: a still export catches words wherever they happen to be, and that
 * is a real position they really occupied. An animated fill is *not* in the
 * simulation, so an export freezes one arbitrary frame of a shimmer — which is
 * exactly the argument that kept the grain static. See the note in
 * `src/engine/background.ts`.
 */

/** Which animated fill a word gets, if any. Matches the shader's `uMaterial`. */
export const MATERIAL_NONE = 0;
export const MATERIAL_FIRE = 1;
export const MATERIAL_WATER = 2;

/**
 * The two words under test. Deliberately not a lookup table that could grow —
 * if this needs a third entry, that is the signal it should be score-driven
 * instead.
 */
const UNDER_TEST = new Map<string, number>([
  ["ember", MATERIAL_FIRE],
  ["ocean", MATERIAL_WATER],
]);

/** The animated fill for a word, or `MATERIAL_NONE`. */
export function materialFor(word: string): number {
  return UNDER_TEST.get(word) ?? MATERIAL_NONE;
}

/**
 * How far the fire's flicker moves the edge threshold, and how fast.
 *
 * Small on purpose: this perturbs where the distance field is *cut*, which is
 * the same knob `age` uses to erode a word. Too much and the letterform stops
 * being a letterform.
 */
export const FIRE_FLICKER_AMOUNT = 0.028;
export const FIRE_FLICKER_HZ = 1.6;

/** How far the water displaces its sample, and the wavelength it does it over. */
export const WATER_RIPPLE_AMOUNT = 0.012;
export const WATER_RIPPLE_HZ = 0.5;
export const WATER_RIPPLE_WAVES = 9;
