/**
 * The room's policy: how full it gets, how it empties, and what it does when
 * nobody is looking.
 *
 * This is deliberately separate from `physics.ts` and `renderer.ts`, which know
 * how to simulate and how to draw but have no opinion about *when*. It is also
 * separate from `boot.ts`, which is wiring — before this module existed, the
 * density cap, the clear gesture and the visibility handling would all have
 * landed there and doubled its size with decisions rather than connections.
 */

import type { PhysicsRoom } from "../engine/physics";
import type { RoomRenderer } from "../engine/renderer";
import type { FrameLoop } from "../engine/loop";
import { roomTintAt, type RoomTint } from "../design/palette";
import { debug } from "../util/debug";

/**
 * Per DESIGN.md: "Soft cap: 200 active bodies. On commit of body #201, the
 * oldest body begins its 2s fade-out."
 *
 * In practice this rarely fires, and that is a finding rather than a bug. A
 * mixed vocabulary settles at around 60 bodies because the crush clears the
 * room faster than typing fills it, and two minutes of typing is 60–100
 * commits. The cap is therefore a long-session safety valve, not the mechanic
 * a visitor experiences — the crush is what they experience. Recorded in
 * `ROADMAP.md` and `docs/build-log.md` rather than tuned away, because words
 * having discoverable physical consequences is the point of the piece and a
 * sparse room with a crater in it is a better composition than a full one.
 */
export const SOFT_CAP_BODIES = 200;

/** DESIGN.md: the clear keybind does nothing below this many bodies. */
const CLEAR_MIN_BODIES = 10;

/**
 * DESIGN.md gives the clear gesture two numbers that disagree above about fifty
 * bodies: "all bodies fade out staggered over 1.5s" and "staggered ~30ms
 * apart". At 200 bodies a 30ms stagger would take six seconds.
 *
 * Resolved by clamping the stagger so the whole gesture always finishes in
 * 1.5s, which makes 30ms exactly right at fifty bodies and tighter above it.
 * The stated total is the promise; the stated stagger is how it should feel at
 * a typical count.
 */
const CLEAR_TOTAL_MS = 1500;
const CLEAR_FADE_MS = 900;
const CLEAR_STAGGER_MAX_MS = 30;

/**
 * How many words the focus nudge may wake, and how hard.
 *
 * DESIGN.md asks for "a small impulse applied to all sleeping bodies so they
 * don't look frozen". All of them is the wrong reading: waking two hundred
 * frozen words costs a second of full-room physics on every tab return, and it
 * would visibly slump sediment the visitor left settled. The surface of the
 * pile is what they can see, and stirring that is what the instruction is
 * actually for.
 */
const FOCUS_NUDGE_BODIES = 40;

export interface Room {
  /**
   * Advance the room's own policy by one fixed step.
   *
   * The soft cap is enforced here rather than from a commit callback, and the
   * distinction is not cosmetic. "No more than `SOFT_CAP_BODIES` words" is an
   * invariant of the room, not a response to an event, and making it an event
   * response means every path that can add a word has to remember to announce
   * itself. The dev console handle did not, and the room quietly reached 215
   * bodies. DESIGN.md's "on commit of body #201" describes what a visitor sees,
   * which this produces either way.
   */
  readonly step: () => void;
  /** Fade every word, newest last. A no-op below `CLEAR_MIN_BODIES`. */
  readonly clear: () => void;
  /** Whether the clear keybind should do anything right now. */
  readonly canClear: () => boolean;
  /** The current time-of-day tint. Recomputed on a minute tick, not per frame. */
  readonly tint: () => RoomTint;
  /** Page visibility changed. Hidden pauses the simulation entirely. */
  readonly onVisibilityChange: (hidden: boolean) => void;
  /** Window focus changed. Only the caret's pulse cares. */
  readonly onFocusChange: (focused: boolean) => void;
}

export function createRoom(
  physics: PhysicsRoom,
  renderer: RoomRenderer,
  loop: FrameLoop,
): Room {
  /** Words already fading, so the cap does not pick the same one twice. */
  const leaving = new Set<number>();

  /**
   * The tint object, rebuilt on a minute tick.
   *
   * Handing back the *same object* between ticks is what lets the renderer
   * decide by identity whether the room's light has moved, and so relight two
   * hundred words once a minute instead of every frame. The whole cycle covers
   * 10° of hue in a day, so a finer clock would be measuring floating-point
   * noise — DESIGN.md's "compute at frame boundary; do not re-sample per
   * frame".
   */
  let tint = roomTintAt(new Date());
  let tintMinute = -1;

  function currentTint(): RoomTint {
    const now = new Date();
    const minute = now.getHours() * 60 + now.getMinutes();
    if (minute !== tintMinute) {
      tintMinute = minute;
      tint = roomTintAt(now);
    }
    return tint;
  }

  /** Retire one word: physics lets go, the renderer sees it out. */
  function retire(id: number, delayMs = 0, durationMs?: number): void {
    if (leaving.has(id)) return;
    leaving.add(id);
    physics.remove(id);
    renderer.fade(id, delayMs, durationMs);
  }

  function enforceSoftCap(): void {
    // `physics.bodies` is already in commit order — ids ascend and `commit`
    // pushes — so the oldest still standing is at the front. No sort needed.
    let live = physics.bodies.length;
    for (const body of physics.bodies) {
      if (live <= SOFT_CAP_BODIES) break;
      if (leaving.has(body.id)) continue;
      retire(body.id);
      live -= 1;
      debug("room", `soft cap: "${body.word}" is being forgotten`);
    }
  }

  return {
    step(): void {
      // An integer comparison against the body count, so running it every step
      // rather than on a commit event costs nothing measurable.
      if (physics.bodies.length > SOFT_CAP_BODIES) enforceSoftCap();
    },

    canClear(): boolean {
      return physics.bodies.length >= CLEAR_MIN_BODIES;
    },

    clear(): void {
      const count = physics.bodies.length;
      if (count < CLEAR_MIN_BODIES) return;

      // Newest *last*, per DESIGN.md — "a visual echo of the accumulation order
      // in reverse". Bodies are in commit order, so index 0 leaves first.
      const stagger = Math.min(
        CLEAR_STAGGER_MAX_MS,
        (CLEAR_TOTAL_MS - CLEAR_FADE_MS) / Math.max(1, count - 1),
      );
      // Copied before iterating: `retire` removes from the live array.
      const ids = physics.bodies.map((body) => body.id);
      for (const [index, id] of ids.entries())
        retire(id, index * stagger, CLEAR_FADE_MS);
      debug(
        "room",
        `clear: ${String(count)} words, ${stagger.toFixed(1)}ms apart`,
      );
    },

    tint: currentTint,

    onVisibilityChange(hidden: boolean): void {
      if (hidden) {
        loop.stop();
        debug("room", "hidden: simulation paused");
        return;
      }
      if (loop.isRunning) return;
      loop.start();

      // Stir the surface so the room does not look embalmed on return. Waking
      // alone would do nothing visible — a settled word is in equilibrium, so
      // it would simply re-freeze having not moved — which is why `stir` shoves
      // as well as wakes. They re-freeze through the usual settle path.
      const surface = physics.surfaceBodies(FOCUS_NUDGE_BODIES);
      for (const body of surface) physics.stir(body.id);
      debug("room", `visible: ${String(surface.length)} surface words stirred`);
    },

    onFocusChange(focused: boolean): void {
      // Only the caret. Physics keys on visibility instead — see the note in
      // `docs/specs/2026-07-27-phase-3-room-design.md`: window blur also fires
      // when the window is merely not frontmost, and freezing a room the
      // visitor is still looking at is not what DESIGN.md's stated reason
      // ("no CPU burn in background") describes.
      renderer.setPulsePaused(!focused);
    },
  };
}
