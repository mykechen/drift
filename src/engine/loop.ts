/**
 * Fixed-timestep frame loop.
 *
 * Simulation advances in whole steps of a constant size regardless of display
 * refresh rate, so physics is deterministic on a 60Hz laptop and a 144Hz
 * monitor alike. Rendering happens once per animation frame with the leftover
 * fraction handed over for interpolation.
 */

import { debug } from "../util/debug";

/**
 * Physics ticks per second. Phase 2 makes this density-aware — 120Hz below 100
 * bodies, 60Hz between 100 and 200 — at which point this becomes a variable.
 */
export const PHYSICS_HZ = 120;

const FIXED_TIMESTEP_MS = 1000 / PHYSICS_HZ;

/**
 * Longest frame delta the accumulator will honour. A backgrounded tab reports
 * an enormous delta on return; without this clamp the loop would try to catch
 * up across hundreds of steps in a single frame and lock the main thread.
 */
const MAX_FRAME_DELTA_MS = 250;

export interface FrameLoopCallbacks {
  /** Advances the simulation by exactly one fixed timestep. */
  step(fixedDeltaMs: number): void;
  /**
   * Draws one frame. `alpha` is how far the clock has travelled toward the
   * next step, in the range [0, 1) — the input to render interpolation.
   */
  render(alpha: number): void;
}

export interface FrameLoop {
  readonly start: () => void;
  readonly stop: () => void;
  readonly isRunning: boolean;
}

export function createFrameLoop(callbacks: FrameLoopCallbacks): FrameLoop {
  let animationFrameId = 0;
  let previousTimeMs = 0;
  let accumulatorMs = 0;
  let running = false;

  function frame(nowMs: number): void {
    animationFrameId = requestAnimationFrame(frame);

    const deltaMs = Math.min(nowMs - previousTimeMs, MAX_FRAME_DELTA_MS);
    previousTimeMs = nowMs;
    accumulatorMs += deltaMs;

    while (accumulatorMs >= FIXED_TIMESTEP_MS) {
      callbacks.step(FIXED_TIMESTEP_MS);
      accumulatorMs -= FIXED_TIMESTEP_MS;
    }

    callbacks.render(accumulatorMs / FIXED_TIMESTEP_MS);
  }

  function start(): void {
    if (running) return;
    running = true;
    previousTimeMs = performance.now();
    accumulatorMs = 0;
    animationFrameId = requestAnimationFrame(frame);
    debug("loop", "start", `${PHYSICS_HZ}Hz`);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    cancelAnimationFrame(animationFrameId);
    debug("loop", "stop");
  }

  return {
    start,
    stop,
    get isRunning(): boolean {
      return running;
    },
  };
}
