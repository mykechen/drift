/**
 * Springs, and the one thing that is not a spring.
 *
 * `DESIGN.md`: "Everything is a spring. Nothing is linear. Nothing is instant."
 * The two configurations below are its numbers verbatim; nothing else in the
 * piece should be inventing a third.
 *
 * Springs step on the **fixed timestep**, not on the frame delta, for the same
 * reason the physics does — a spring integrated against a variable delta
 * settles differently on a 60Hz laptop and a 144Hz monitor, and the commit
 * animation is the most-watched 400ms in the piece.
 */

export interface SpringConfig {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

/** Springy but settles. The room's default gesture. */
export const DEFAULT_SPRING: SpringConfig = {
  stiffness: 220,
  damping: 24,
  mass: 1,
};

/**
 * More overshoot; makes commit feel decisive.
 *
 * Note a discrepancy in `DESIGN.md` that is deliberately not resolved in code.
 * It asks for both "~180ms" and these constants, and they describe different
 * springs. Measured at ζ = 0.671: the first overshoot peak lands at **308ms**
 * and the spring retires at **658ms**. The named constants are the explicit
 * instruction, so they are what ships; the duration is on the author's list to
 * judge by eye. Changing it means raising `stiffness` to roughly 1000, which is
 * a different feel, not a different number.
 *
 * Worth knowing before tuning it: overshoot is a fraction of the *travel*, not
 * of the target. This spring overshoots by 5.8% of however far it is asked to
 * move, so driving scale from 0.92 to 1.0 peaks at 1.004 — a snap you feel in
 * the arrival, not a visible bounce past full size. The default spring
 * overshoots 1.1% of travel, so "more overshoot" holds as a comparison between
 * the two even though neither is large in absolute terms.
 */
export const COMMIT_SPRING: SpringConfig = {
  stiffness: 180,
  damping: 18,
  mass: 1,
};

export interface Spring {
  /** Current value. Read this; the integrator owns writing it. */
  value: number;
  velocity: number;
  target: number;
  readonly config: SpringConfig;
  /**
   * How far this spring was asked to travel. Rest is judged relative to it —
   * see `springAtRest`.
   */
  readonly travel: number;
}

export function createSpring(
  config: SpringConfig,
  initial: number,
  target: number,
): Spring {
  return {
    value: initial,
    velocity: 0,
    target,
    config,
    travel: Math.abs(target - initial),
  };
}

/**
 * Advance one spring by one fixed step.
 *
 * Semi-implicit Euler — velocity is integrated first and the *new* velocity
 * moves the value. Explicit Euler injects energy at these stiffnesses and an
 * underdamped spring driven by it grows rather than settles.
 */
export function stepSpring(spring: Spring, fixedDeltaMs: number): void {
  const dt = fixedDeltaMs / 1000;
  const { stiffness, damping, mass } = spring.config;
  const force =
    -stiffness * (spring.value - spring.target) - damping * spring.velocity;
  spring.velocity += (force / mass) * dt;
  spring.value += spring.velocity * dt;
}

/**
 * Rest thresholds, both as fractions of the distance the spring was asked to
 * travel — position within 0.2% of it, and moving slower than 2% of it a
 * second.
 *
 * **Relative, not absolute, and that is load-bearing.** An absolute epsilon
 * larger than the travel reports rest at the *overshoot peak*: the spring is
 * momentarily at zero velocity there and already within epsilon of its target,
 * so both conditions pass while it is about to swing back. Measured on the
 * commit spring at a 0.92 → 1.0 travel, an absolute 0.005 retired it at 308ms,
 * exactly the peak. Scaling by travel makes the test mean the same thing for a
 * spring moving 0.08 and one moving 500.
 */
const SPRING_REST_POSITION_FRACTION = 0.002;
const SPRING_REST_VELOCITY_FRACTION = 0.02;

/**
 * Whether a spring has arrived and stopped.
 *
 * Both conditions are required. Position alone reports rest at every crossing
 * of the target, which for an overshooting spring is the moment it is moving
 * fastest.
 */
export function springAtRest(spring: Spring): boolean {
  // A spring with nowhere to go is already there; without this the relative
  // thresholds are both zero and it could never retire.
  if (spring.travel === 0) return true;
  return (
    Math.abs(spring.value - spring.target) <
      SPRING_REST_POSITION_FRACTION * spring.travel &&
    Math.abs(spring.velocity) < SPRING_REST_VELOCITY_FRACTION * spring.travel
  );
}

// --- The shake --------------------------------------------------------------

/**
 * The refusal gesture: `DESIGN.md` asks for a "subtle shake" on a rejected
 * commit, a keystroke past the 24-character cap, and backspace into an empty
 * buffer.
 *
 * Not a spring, deliberately. A spring travels from one value to another, and
 * this has nowhere to go — it starts and ends at zero. A damped sine says that
 * directly instead of encoding it as a spring already at its target with an
 * impulse applied.
 */
export const SHAKE_DURATION_MS = 120;
const SHAKE_AMPLITUDE_EM = 0.08;
const SHAKE_CYCLES = 2.5;

/** Horizontal offset in em for a shake that began `elapsedMs` ago. Zero once done. */
export function shakeOffset(elapsedMs: number): number {
  if (elapsedMs < 0 || elapsedMs >= SHAKE_DURATION_MS) return 0;
  const t = elapsedMs / SHAKE_DURATION_MS;
  // Amplitude decays linearly to zero, so the gesture ends exactly where it
  // started rather than being cut off mid-swing.
  return (
    Math.sin(t * SHAKE_CYCLES * 2 * Math.PI) * SHAKE_AMPLITUDE_EM * (1 - t)
  );
}
