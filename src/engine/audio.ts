/**
 * The synthesiser: Web Audio directly, no framework and no samples.
 *
 * `src/design/sound.ts` decides what a word sounds like. This decides how that
 * becomes air. Every voice here is the same two-part shape — a pitched body
 * that falls as it decays, and a noise transient for the instant of contact —
 * which is what a real impact is, and what makes a synthesised thud read as
 * something striking something rather than as a beep.
 *
 * **Nothing is created until a gesture.** Browsers start an `AudioContext`
 * suspended and only a user gesture may resume it, so the context is built
 * lazily on the first keystroke or click. Building it at load would leave a
 * suspended context that silently swallows everything until the visitor
 * happened to click, which is a bug that only appears for people who type
 * before they click.
 */

import {
  AUDIBLE_IMPACT_SPEED,
  BACKSPACE,
  BED_CUTOFF_HZ,
  BED_DENSITY_FULL,
  BED_DENSITY_LIFT,
  BED_GAIN,
  BED_MODULATION_HZ,
  COMMIT,
  impactVoice,
  KEYPRESS,
  MASTER_GAIN,
  REFUSED,
  type ImpactVoice,
} from "../design/sound";
import type { Impact } from "./physics";
import { debug } from "../util/debug";

/** A short one-shot voice with a fixed pitch — the keyboard and commit sounds. */
interface FixedVoice {
  readonly pitchHz: number;
  readonly decayMs: number;
  readonly gain: number;
}

/**
 * How many voices may sound in one frame.
 *
 * A `mountain` landing in a full room can crush a dozen words and shove a dozen
 * more, and every one of those is a contact. Past a handful the ear cannot
 * separate them anyway and they only sum into a click, so the rest are dropped
 * — loudest first, which is what the ear would have picked out regardless.
 *
 * Lowered from four to three to bring the worst synthetic case under the
 * ceiling, and it is the right lever because it does *not* make a single
 * landing quieter: with the 1/sqrt(n) duck, three voices sum to 1.73× one voice
 * where four sum to 2.0×, so the cap buys 1.3 dB off the pile-up and nothing
 * off the common case.
 */
const MAX_VOICES_PER_FRAME = 3;

/** Seconds of noise, generated once and reused by every transient. */
const NOISE_SECONDS = 0.4;

export interface RoomAudio {
  /**
   * Resume or create the context. Safe to call on every gesture; it is a no-op
   * once running.
   */
  readonly wake: () => void;
  readonly setMuted: (muted: boolean) => void;
  readonly isMuted: () => boolean;
  /** Voice a batch of contacts, loudest first, capped. */
  readonly impacts: (batch: readonly Impact[]) => void;
  readonly keypress: () => void;
  readonly backspace: () => void;
  readonly commit: () => void;
  readonly refused: () => void;
  /** How full the room is, which the bed leans on. */
  readonly setDensity: (bodies: number) => void;
  readonly suspend: () => void;
  /**
   * Peak amplitude observed since the last call, 0–1. Development only —
   * returns 0 in production, where no analyser is attached.
   *
   * `DESIGN.md` forbids anything above −20 dB peak, which is 0.1 linear. That
   * is not safe by construction: `MAX_VOICES_PER_FRAME` voices at full gain
   * would sum to 0.6 before the limiter, and a limiter with a 2ms attack lets
   * the leading transient through. So it is measured instead of argued.
   */
  readonly peak: () => number;
}

export function createRoomAudio(): RoomAudio {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let bedGain: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let analyser: AnalyserNode | null = null;
  // Explicitly backed by an ArrayBuffer: `getFloatTimeDomainData` refuses a
  // Float32Array whose buffer type is the wider ArrayBufferLike.
  let scratch: Float32Array<ArrayBuffer> | null = null;
  let muted = false;
  let density = 0;

  function build(): void {
    if (context) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    context = new Ctor();

    // A limiter on the master bus, as a safety net rather than the mechanism.
    const limiter = context.createDynamicsCompressor();
    // Catches the *sum* of many voices, which is all a compressor can do here.
    // Measured: with a 2 ms attack it lets a percussive transient through
    // almost untouched, so the voices are set quiet enough to clear the ceiling
    // individually and this only holds the pile-ups.
    limiter.threshold.value = -30;
    limiter.knee.value = 4;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.15;

    // A brickwall after the limiter, so the ceiling is a *guarantee* rather
    // than the outcome of tuning. `y = C·tanh(x/C)` is transparent well below C
    // — a realistic peak of 0.05 passes through as 0.0499 — and asymptotically
    // cannot exceed C however much is thrown at it.
    //
    // It is here because the compressor alone provably could not do the job:
    // its 2 ms attack passes percussive transients, and measured pile-ups sat
    // 8 dB over the ceiling with it in circuit. Tuning the voices fixed every
    // realistic case; this fixes the rest by construction.
    const ceiling = context.createWaveShaper();
    const curve = new Float32Array(4096);
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = MASTER_GAIN * Math.tanh(x / MASTER_GAIN);
    }
    ceiling.curve = curve;
    ceiling.oversample = "2x";

    limiter.connect(ceiling);
    ceiling.connect(context.destination);

    master = context.createGain();
    master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(limiter);

    // Tapped after the limiter, because what matters is what leaves the bus.
    if (import.meta.env.DEV) {
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      scratch = new Float32Array(analyser.fftSize);
      ceiling.connect(analyser);
    }

    noise = context.createBuffer(
      1,
      Math.floor(context.sampleRate * NOISE_SECONDS),
      context.sampleRate,
    );
    const samples = noise.getChannelData(0);
    // Deterministic rather than Math.random, so a replayed session sounds the
    // same as the one it replays — the same reason the settle tilt is hashed.
    let seed = 0x9e3779b9;
    for (let i = 0; i < samples.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      samples[i] = (seed / 0xffffffff) * 2 - 1;
    }

    startBed();
    debug("audio", `context at ${String(context.sampleRate)}Hz`);
  }

  /**
   * The room tone. Filtered noise with a slow wander on the cutoff — the
   * atmosphere, and the one sound that is always present.
   */
  function startBed(): void {
    if (!context || !master || !noise) return;

    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = BED_CUTOFF_HZ;
    filter.Q.value = 0.7;

    // Very slow, so it is felt as the room having air rather than heard as a
    // filter sweep.
    const lfo = context.createOscillator();
    lfo.frequency.value = BED_MODULATION_HZ;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = BED_CUTOFF_HZ * 0.35;
    lfo.connect(lfoDepth).connect(filter.frequency);

    bedGain = context.createGain();
    bedGain.gain.value = BED_GAIN;

    source.connect(filter).connect(bedGain).connect(master);
    source.start();
    lfo.start();
  }

  /**
   * One impact: a pitched body that falls as it decays, plus a noise transient.
   *
   * The falling pitch is what separates a struck object from a note. A real
   * impact's resonance drops as the contact deforms and releases, so a fixed
   * pitch reads as a synthesiser and a falling one reads as a thing landing.
   */
  function voice(v: ImpactVoice | FixedVoice, transient = 0): void {
    if (!context || !master) return;
    const now = context.currentTime;
    const decay = Math.max(0.01, v.decayMs / 1000);

    const shaped = context.createBiquadFilter();
    shaped.type = "lowpass";
    shaped.frequency.value =
      "cutoffHz" in v ? v.cutoffHz : Math.max(600, v.pitchHz * 4);
    shaped.Q.value = 0.9;
    shaped.connect(master);

    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(v.pitchHz, now);
    // Down a fifth over the decay. Exponential because pitch is perceived that
    // way, and because `linearRampToValueAtTime` through low frequencies audibly
    // stalls at the bottom.
    body.frequency.exponentialRampToValueAtTime(
      Math.max(20, v.pitchHz * 0.66),
      now + decay,
    );

    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(0, now);
    // A 2ms attack rather than an instant one: a true step produces a click of
    // its own, which is audible as a defect on the quietest voices.
    bodyGain.gain.linearRampToValueAtTime(
      v.gain * (1 - transient * 0.4),
      now + 0.002,
    );
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    body.connect(bodyGain).connect(shaped);
    body.start(now);
    body.stop(now + decay + 0.02);

    if (transient <= 0 || !noise) return;

    // The contact itself: a very short band-limited noise burst on top.
    const burst = context.createBufferSource();
    burst.buffer = noise;
    const burstLength = Math.min(decay, 0.045);
    const burstFilter = context.createBiquadFilter();
    burstFilter.type = "bandpass";
    burstFilter.frequency.value = Math.min(4200, v.pitchHz * 8);
    burstFilter.Q.value = 0.8;
    const burstGain = context.createGain();
    burstGain.gain.setValueAtTime(0, now);
    burstGain.gain.linearRampToValueAtTime(v.gain * transient, now + 0.001);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, now + burstLength);
    burst.connect(burstFilter).connect(burstGain).connect(shaped);
    burst.start(now, 0, burstLength + 0.01);
  }

  return {
    wake(): void {
      build();
      if (context?.state === "suspended") void context.resume();
    },

    setMuted(next: boolean): void {
      muted = next;
      if (master && context)
        master.gain.setTargetAtTime(
          next ? 0 : MASTER_GAIN,
          context.currentTime,
          0.02,
        );
    },

    isMuted: (): boolean => muted,

    impacts(batch: readonly Impact[]): void {
      if (!context || muted || batch.length === 0) return;
      const audible = batch.filter((i) => i.speed >= AUDIBLE_IMPACT_SPEED);
      if (audible.length === 0) return;
      // Loudest first, then capped: if the frame has more contacts than the ear
      // can separate, the ones it would have picked out are the ones kept.
      audible.sort((a, b) => b.speed - a.speed);
      const sounding = audible.slice(0, MAX_VOICES_PER_FRAME);
      // Duck by 1/sqrt(n). Voices that land together are uncorrelated — different
      // pitches, different phases — so they sum in *power* rather than amplitude,
      // and 1/sqrt(n) is exactly what holds the total constant under that sum.
      // Without it, measured, twelve heavy words landing at once peaked 8 dB over
      // DESIGN.md's ceiling even with the limiter in circuit.
      const duck = 1 / Math.sqrt(sounding.length);
      for (const impact of sounding) {
        const v = impactVoice(impact.scores, impact.speed, impact.againstRoom);
        voice({ ...v, gain: v.gain * duck }, v.transient);
      }
    },

    keypress(): void {
      voice(KEYPRESS, 0.9);
    },
    backspace(): void {
      voice(BACKSPACE, 0.8);
    },
    commit(): void {
      voice(COMMIT, 0.35);
    },
    refused(): void {
      voice(REFUSED, 0.5);
    },

    setDensity(bodies: number): void {
      density = bodies;
      if (!bedGain || !context) return;
      const lift =
        1 + Math.min(1, density / BED_DENSITY_FULL) * BED_DENSITY_LIFT;
      bedGain.gain.setTargetAtTime(BED_GAIN * lift, context.currentTime, 1.5);
    },

    peak(): number {
      if (!analyser || !scratch) return 0;
      analyser.getFloatTimeDomainData(scratch);
      let highest = 0;
      for (const sample of scratch)
        highest = Math.max(highest, Math.abs(sample));
      return highest;
    },

    suspend(): void {
      if (context?.state === "running") void context.suspend();
    },
  };
}
