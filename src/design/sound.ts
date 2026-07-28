/**
 * What the room sounds like — the mapping from a word's meaning to its voice.
 *
 * This file holds the *design*: which score drives which acoustic property, and
 * the constants that bound them. `src/engine/audio.ts` holds the synthesis. The
 * split is the same one the rest of the piece uses — design says what, engine
 * says how.
 *
 * **Everything is synthesised; nothing is sampled.** `CLAUDE.md` specifies a
 * `Sampler` reading "small mp3s from `/public/audio/`", and synthesis replaces
 * it for three reasons. It costs **zero payload**, against a budget whose
 * non-ML overhead is about 520 KB in total. `DESIGN.md` asks repeatedly for
 * sound that varies parametrically — "pitch varies with mass", "pitch varies
 * with combined mass" — which is synthesis's native mode, where pitch-shifting
 * one sample across a 5:1 mass range is chipmunky at one end and muddy at the
 * other. And it keeps the piece's premise intact: every other property of a
 * word is *computed* from what it means, so a fixed audio asset would be the
 * one place a recording stood in for a model output.
 *
 * The risk this takes on is that synthesised sound reads thin or video-gamey,
 * and `DESIGN.md` is emphatic about the ambient bed. That is a judgement to
 * make by listening, not by reading the numbers below.
 */

import type { PropertyScores } from "../ml/properties";

/**
 * Below this contact speed nothing is heard, in world units per second.
 *
 * Measured rather than chosen. A settled room that is *breathing* — 40 light
 * words, none frozen — produced exactly **one** contact in twelve seconds, at
 * speed 0.074, and a settled heavy room produced none: Rapier reports contact
 * *starts*, and the breath rocks words inside contacts that already exist
 * rather than making new ones. The feared endless chatter does not happen.
 *
 * What does happen is a tail of micro-contacts as a word beds in, measured at
 * 0.07–0.13, against real landings and bounces at 0.8 and up. This sits in that
 * gap. `DESIGN.md`'s "only above a collision velocity threshold" was written for
 * a room where everything froze solid; the number survives the room that
 * breathes, which had to be checked rather than assumed.
 */
export const AUDIBLE_IMPACT_SPEED = 0.5;

/**
 * The impact speed at which a landing is as loud as it gets. Measured: a
 * `mountain` reaches the floor at 12.0 units/s and a `feather` at 2.3, so the
 * physics already delivers most of the dynamic range before mass is consulted
 * at all.
 */
export const IMPACT_SPEED_AT_LOUDEST = 12;

/**
 * Landing pitch across the mass range, in Hz.
 *
 * The single most important mapping in the file: it is what makes a `mountain`
 * a thud and a `feather` a tick. Low enough at the heavy end to be felt rather
 * than heard, high enough at the light end to stay out of the bed's way.
 */
const PITCH_AT_HEAVIEST = 52;
const PITCH_AT_LIGHTEST = 300;

/**
 * How long a landing rings, in ms. Heavy words ring *longer*, not shorter — a
 * big low body has more to give up — while a light word is a brief tap.
 */
const DECAY_MS_AT_HEAVIEST = 240;
const DECAY_MS_AT_LIGHTEST = 70;

/**
 * Voice gain across the mass range, before the impact-speed scaling.
 *
 * **Set by measurement, not by taste, and the first values were 5× too loud.**
 * At 1.0 and 0.22 a `mountain` landing peaked at −10.2 dBFS and twelve heavy
 * words landing together at −7.7, against `DESIGN.md`'s hard −20 dB ceiling.
 *
 * The limiter was supposed to catch that and does not: a `DynamicsCompressor`
 * has a 2 ms attack and a percussive transient is largely through before its
 * gain reduction engages. So a limiter can only ever be a safety net for the
 * sum of many voices — the individual voices have to be quiet enough on their
 * own. Re-measured after this change; the numbers are in `docs/build-log.md`.
 */
const GAIN_AT_HEAVIEST = 0.115;
const GAIN_AT_LIGHTEST = 0.026;

/**
 * Timbre from `warmth`, as the lowpass cutoff in Hz above the fundamental.
 *
 * A warm word is woody: energy in the low-mids, little on top. A cool word is
 * glassy and keeps its high frequencies. This is the same score that renders
 * `cedar` rust and `glacier` blue, so a word sounds like it looks.
 */
const CUTOFF_AT_WARMEST = 900;
const CUTOFF_AT_COOLEST = 5200;

/**
 * `age` damps. An old word lands dull and dusty, as though dropped on cloth
 * rather than on a table — less tone, more of the contact's noise, and a
 * shorter tail. Applied to positive age only, exactly as the ink fade is, so a
 * word of neutral age is not already half-damped.
 */
const DAMPING_AT_OLDEST = 0.55;

/**
 * `intensity` sets how much of the voice is the sharp noise transient of
 * contact versus the body of the tone. A `scream` cracks; a `hush` is all body
 * and no attack.
 */
const TRANSIENT_AT_QUIETEST = 0.12;
const TRANSIENT_AT_LOUDEST = 0.75;

/** Map a score in [-1, 1] onto a range. */
function across(score: number, atNegative: number, atPositive: number): number {
  const t = (Math.max(-1, Math.min(1, score)) + 1) / 2;
  return atNegative + t * (atPositive - atNegative);
}

/** Everything the synthesiser needs to voice one contact. */
export interface ImpactVoice {
  readonly pitchHz: number;
  readonly decayMs: number;
  readonly gain: number;
  readonly cutoffHz: number;
  /** 0–1, how much of the voice is the contact transient rather than tone. */
  readonly transient: number;
}

/**
 * The voice for one contact: a word's six scores plus how hard it hit.
 *
 * Speed and mass do different jobs and both are needed. Speed is *how hard* —
 * the same word landing from a height or being nudged. Mass is *what it is* —
 * the pitch and length that make it recognisable as that word however hard it
 * lands.
 */
export function impactVoice(
  scores: PropertyScores,
  speed: number,
  againstRoom: boolean,
): ImpactVoice {
  const damping = Math.max(0, Math.min(1, scores.age)) * DAMPING_AT_OLDEST;

  const force = Math.min(1, speed / IMPACT_SPEED_AT_LOUDEST);
  // Square-rooted, because loudness is perceived closer to logarithmically than
  // linearly in the driving quantity — a linear map makes every soft landing
  // effectively silent and bunches the rest at the top.
  const loudness = Math.sqrt(force);

  return {
    pitchHz: across(scores.mass, PITCH_AT_LIGHTEST, PITCH_AT_HEAVIEST),
    decayMs:
      across(scores.mass, DECAY_MS_AT_LIGHTEST, DECAY_MS_AT_HEAVIEST) *
      (1 - damping * 0.5),
    gain:
      across(scores.mass, GAIN_AT_LIGHTEST, GAIN_AT_HEAVIEST) *
      loudness *
      // Word-on-word contact is softer than the floor: two soft things meeting.
      (againstRoom ? 1 : 0.7),
    cutoffHz:
      across(scores.warmth, CUTOFF_AT_COOLEST, CUTOFF_AT_WARMEST) *
      (1 - damping),
    transient:
      across(scores.intensity, TRANSIENT_AT_QUIETEST, TRANSIENT_AT_LOUDEST) *
      (1 - damping),
  };
}

// --- The fixed voices -------------------------------------------------------

/** Per DESIGN.md: "soft tick, ~1kHz, 15ms". A well-machined keyboard. */
export const KEYPRESS = { pitchHz: 1000, decayMs: 15, gain: 0.09 };
/** "Slightly duller tick" — distinct from a letter without being a new sound. */
export const BACKSPACE = { pitchHz: 620, decayMs: 18, gain: 0.085 };
/** "Small woody thud, 200Hz filter, 60ms decay". Marks becoming physical. */
export const COMMIT = { pitchHz: 200, decayMs: 60, gain: 0.15 };
/** The refusal. Not in DESIGN.md's table; the shake needed a voice. */
export const REFUSED = { pitchHz: 150, decayMs: 45, gain: 0.16 };

/**
 * Master ceiling. `DESIGN.md`: "Any sound louder than -20dB peak" is forbidden,
 * and −20 dBFS is 0.1 in linear amplitude.
 */
export const MASTER_GAIN = 0.1;

/** The ambient bed: "very quiet room tone, ~-45dB, slight modulation". */
export const BED_GAIN = 0.006;
export const BED_CUTOFF_HZ = 340;
/** Slow enough that it is felt as the room having air, not heard as an effect. */
export const BED_MODULATION_HZ = 0.06;
/**
 * How much the bed lifts as the room fills, and the body count it reaches that
 * lift at — `DESIGN.md`'s "slight modulation with word density".
 */
export const BED_DENSITY_LIFT = 0.5;
export const BED_DENSITY_FULL = 120;
