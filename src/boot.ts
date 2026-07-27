/**
 * Drift — the piece itself, everything a desktop visitor loads.
 *
 * The commit pipeline lives here: a typed word becomes six property scores,
 * which become variable font axes, which become glyph outlines, which become
 * convex hulls, which become a body that falls. Every step is somewhere else;
 * this file is only the order of them.
 *
 * Split out of `main.ts` in Phase 2.5. `main.ts` decides whether this module is
 * worth downloading at all, and everything expensive — Rapier, OGL, the baked
 * glyph outlines, the ONNX runtime, the model — hangs off this side of that
 * decision.
 *
 * Phase 2 draws bodies as flat fills of their own triangulation. The SDF that
 * replaces it lands in Phase 3 — per ROADMAP the piece is meant to be
 * functional and ugly before it is beautiful.
 */

import { attachWordInput } from "./engine/input";
import { loadGlyphSource, type GlyphSource } from "./engine/glyphs";
import { createFrameLoop } from "./engine/loop";
import {
  createPhysicsRoom,
  WORD_EM_UNITS,
  type PhysicsRoom,
} from "./engine/physics";
import { createRoomRenderer } from "./engine/renderer";
import { axesForScores, NEUTRAL_AXES } from "./design/typography";
import { roomTintAt, type RoomTint } from "./design/palette";
import { loadPropertyModel, type PropertyModel } from "./ml/properties";
import { NEUTRAL_SCORES } from "./ml/fallback";
import { debug } from "./util/debug";

/**
 * Commit one word: score it, render it at the axes its scores imply, cut it
 * into hulls, and drop it in.
 *
 * Inference is awaited rather than blocking. `session.run()` is always
 * asynchronous and at ~0.1ms the wait lands well inside a single frame, which
 * is what DESIGN.md's "synchronously" actually needs to mean.
 */
async function commitWord(
  renderer: ReturnType<typeof createRoomRenderer>,
  model: PropertyModel | null,
  glyphSource: GlyphSource,
  physics: PhysicsRoom,
  raw: string,
  spawnX: number,
): Promise<void> {
  const prediction = model ? await model.predict(raw) : null;
  const scores = prediction?.scores ?? NEUTRAL_SCORES;
  const word = prediction?.word ?? raw.toLowerCase();

  const geometry = glyphSource.geometryFor(word, axesForScores(scores));
  const body = physics.commit(word, geometry, scores, spawnX);
  if (!body) return;

  renderer.attach(body);
}

/**
 * Build the room, wire the input, and start the frame loop.
 *
 * **Nothing waits on the network that does not have to.** Until Phase 2.5 this
 * awaited all three loads together and drew its first frame after the last of
 * them — so the visitor sat on a blank page until ~2.7MB of outlines, ONNX
 * runtime and model had arrived, for a room that is empty anyway. Now the two
 * fetches are started first and left in flight, the room is built from Rapier
 * — which has already been instantiated by the time this module's body runs,
 * since its `.wasm` is a static import of this chunk — and the frame loop
 * starts against the empty room immediately. Typing is enabled when the assets
 * that typing actually needs have landed.
 *
 * The staging is deliberately conservative: input waits for the *model*, not
 * just the font. Committing a word before the model can score it would give it
 * neutral properties, and a `boulder` that falls like a leaf because it was
 * typed early fails the piece's first feel test. Better a room that is briefly
 * not typeable than one that briefly lies.
 */
export async function startRoom(canvas: HTMLCanvasElement): Promise<void> {
  const renderer = createRoomRenderer(canvas);

  // Started before anything is awaited, so the two long fetches are in flight
  // while the room is being built. Collected into one promise here rather than
  // awaited later so neither rejection is ever momentarily unhandled.
  const assets = Promise.all([
    loadGlyphSource(),
    // The room must still accept typing if inference cannot start, so a failed
    // model degrades to neutral scores rather than taking the piece down.
    loadPropertyModel().catch((error: unknown): null => {
      debug("ml", "property model unavailable, falling back to neutral", error);
      return null;
    }),
  ]);

  const room = createPhysicsRoom(renderer.aspect());

  window.addEventListener("resize", (): void => {
    renderer.resize();
    room.setAspect(renderer.aspect());
  });

  /**
   * The cursor's horizontal position in world units — where the next word forms
   * and lands. It follows the mouse in x only, clamped so a word cannot spawn
   * half-off the frame. DESIGN.md's original centred, fixed cursor was changed
   * here: placing words is how the room is composed and how the pile gets the
   * horizontal spread it needs to settle.
   */
  const CURSOR_EDGE_MARGIN_UNITS = 0.5;
  let cursorX = 0;
  window.addEventListener("mousemove", (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    const limit = Math.max(0, room.roomWidth / 2 - CURSOR_EDGE_MARGIN_UNITS);
    cursorX = Math.max(
      -limit,
      Math.min(limit, (fraction - 0.5) * room.roomWidth),
    );
  });

  /**
   * The time-of-day tint, recomputed on a minute tick rather than per frame.
   *
   * The whole cycle moves 10° of hue over twenty-four hours, so per-frame
   * sampling would be measuring floating-point noise — which is what
   * DESIGN.md's "compute at frame boundary; do not re-sample per frame" is
   * asking for. The renderer compares tint objects by identity to decide when
   * to relight the room's ink, so handing back the *same* object between ticks
   * is what makes that cheap.
   */
  let tint: RoomTint = roomTintAt(new Date());
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

  const loop = createFrameLoop({
    physicsHz: (): number => room.physicsHz(),
    step(fixedDeltaMs): void {
      room.step(fixedDeltaMs);
      // Commit springs advance on the same fixed timestep as the simulation, so
      // a word arrives identically on a 60Hz laptop and a 144Hz monitor.
      renderer.step(fixedDeltaMs);
      // Words crushed this step have already lost their bodies; hand them to the
      // renderer to press flat and fade where they sat.
      for (const id of room.drainCrushed()) renderer.crush(id);
    },
    render(): void {
      renderer.render(
        room.bodies,
        room.roomWidth / 2,
        room.roomHeight / 2,
        WORD_EM_UNITS,
        cursorX,
        currentTint(),
      );
    },
  });

  // The empty room is on screen from here. Everything below waits on the
  // network; nothing above it does.
  loop.start();
  debug(
    "loop",
    `room ${room.roomWidth.toFixed(1)} units wide, awaiting assets`,
  );

  const [glyphs, properties] = await assets;

  attachWordInput(window, {
    onChange(buffer): void {
      // The uncommitted word renders at neutral axes, not at the axes its scores
      // imply. Per DESIGN.md the model's opinion arrives *on commit* — that is the
      // moment the commit spring exists to dramatise, and pre-empting it would
      // spend the effect before the word is a body.
      renderer.setDraft(
        buffer.length === 0 ? null : glyphs.outlineFor(buffer, NEUTRAL_AXES),
      );
    },
    onCommit(word): void {
      // Cleared here rather than after inference resolves, so the draft does not
      // linger for a frame on top of the body that replaces it.
      renderer.setDraft(null);
      void commitWord(renderer, properties, glyphs, room, word, cursorX);
    },
  });

  debug(
    "loop",
    `ready · ${properties ? properties.backend : "no model"} · ` +
      `room ${room.roomWidth.toFixed(1)}x${String(room.roomHeight)} units`,
  );

  // Development-only handle for the physics stress test and for inspecting body
  // state from a console. `import.meta.env.DEV` is inlined at build time, so this
  // block and the property it defines are dead code in production.
  if (import.meta.env.DEV) {
    (window as unknown as { drift: unknown }).drift = {
      room,
      glyphs,
      properties,
      renderer,
      commit: (word: string, spawnX = cursorX) =>
        commitWord(renderer, properties, glyphs, room, word, spawnX),
    };
  }
}
