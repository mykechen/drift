/**
 * Drift — entry point.
 *
 * The commit pipeline lives here: a typed word becomes six property scores,
 * which become variable font axes, which become glyph outlines, which become
 * convex hulls, which become a body that falls. Every step is somewhere else;
 * this file is only the order of them.
 *
 * Phase 2 draws bodies as flat fills of their own triangulation. The SDF that
 * replaces it lands in Phase 3 — per ROADMAP the piece is meant to be
 * functional and ugly before it is beautiful.
 */

import "./style.css";
import { attachWordInput } from "./engine/input";
import { loadGlyphSource, type GlyphSource } from "./engine/glyphs";
import { createFrameLoop } from "./engine/loop";
import {
  createPhysicsRoom,
  WORD_EM_UNITS,
  type PhysicsRoom,
} from "./engine/physics";
import { createRoomRenderer } from "./engine/renderer";
import {
  axesForScores,
  DISPLAY_FONT_URL,
  NEUTRAL_AXES,
} from "./design/typography";
import { loadPropertyModel, type PropertyModel } from "./ml/properties";
import { NEUTRAL_SCORES } from "./ml/fallback";
import { debug } from "./util/debug";

const canvas = document.querySelector<HTMLCanvasElement>("canvas#room");
if (!canvas) {
  throw new Error("Drift: the #room canvas is missing from the document.");
}

const renderer = createRoomRenderer(canvas);

// The three loads are independent and all needed before the first word can
// commit, so they run together rather than in sequence.
const [room, glyphs, properties] = await Promise.all([
  createPhysicsRoom(renderer.aspect()),
  loadGlyphSource(DISPLAY_FONT_URL),
  // The room must still accept typing if inference cannot start, so a failed
  // model degrades to neutral scores rather than taking the piece down.
  loadPropertyModel().catch((error: unknown): null => {
    debug("ml", "property model unavailable, falling back to neutral", error);
    return null;
  }),
]);

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
 * Commit one word: score it, render it at the axes its scores imply, cut it
 * into hulls, and drop it in.
 *
 * Inference is awaited rather than blocking. `session.run()` is always
 * asynchronous and at ~0.1ms the wait lands well inside a single frame, which
 * is what DESIGN.md's "synchronously" actually needs to mean.
 */
async function commitWord(
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
    void commitWord(properties, glyphs, room, word, cursorX);
  },
});

const loop = createFrameLoop({
  physicsHz: (): number => room.physicsHz(),
  step(fixedDeltaMs): void {
    room.step(fixedDeltaMs);
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
    );
  },
});

loop.start();
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
      commitWord(properties, glyphs, room, word, spawnX),
  };
}
