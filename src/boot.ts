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
import {
  loadGlyphSource,
  type GlyphSource,
  type WordOutline,
} from "./engine/glyphs";
import { createFrameLoop } from "./engine/loop";
import {
  createPhysicsRoom,
  WORD_EM_UNITS,
  type PhysicsRoom,
} from "./engine/physics";
import { createRoomRenderer } from "./engine/renderer";
import { axesForScores, NEUTRAL_AXES } from "./design/typography";
import { createRoom } from "./world/room";
import {
  loadPropertyModel,
  normalizeWord,
  type PropertyModel,
} from "./ml/properties";
import { loadLexicon, type Lexicon } from "./ml/lexicon";
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
/**
 * Whether the room will take this string, decided synchronously.
 *
 * Separate from `commitWord` because the answer has to be immediate: the input
 * layer keeps the buffer on a refusal so the visitor can fix the word, and it
 * cannot wait on inference to find out. Validation is two set lookups; scoring
 * is the async part and only happens once the answer is yes.
 *
 * `lexicon` may be null if its fetch failed, in which case anything spellable
 * is accepted — a room that refuses every word is broken in a way a briefly
 * permissive one is not.
 */
function canCommit(lexicon: Lexicon | null, raw: string): boolean {
  // `normalizeWord` still carries the length cap and the digit rule. Both are
  // now also enforced at the keystroke, so this is defence rather than the
  // primary gate — but it is the one place that cannot be bypassed.
  const word = normalizeWord(raw);
  if (word === null) return false;
  return lexicon === null || lexicon.has(word);
}

/**
 * Commit one word: score it, render it at the axes its scores imply, cut it
 * into hulls, and drop it in.
 *
 * Inference is awaited rather than blocking. `session.run()` is always
 * asynchronous and at ~0.1ms the wait lands well inside a single frame, which
 * is what DESIGN.md's "synchronously" actually needs to mean.
 *
 * Assumes `canCommit` has already said yes.
 */
async function commitWord(
  renderer: ReturnType<typeof createRoomRenderer>,
  model: PropertyModel | null,
  glyphSource: GlyphSource,
  physics: PhysicsRoom,
  raw: string,
  spawnX: number,
  spawnY: number,
): Promise<void> {
  const prediction = model ? await model.predict(raw) : null;
  const scores = prediction?.scores ?? NEUTRAL_SCORES;

  // Letters only reach here — punctuation and digits are refused at the
  // keystroke — so the glyph is simply the word, lowercased. DESIGN.md's
  // "trailing punctuation is preserved in the glyph" rule no longer applies,
  // because no punctuation can be typed; see the note in that document.
  const glyph = raw.toLowerCase();

  const geometry = glyphSource.geometryFor(glyph, axesForScores(scores));
  const body = physics.commit(glyph, geometry, scores, spawnX, spawnY);
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
    // The lexicon decides what counts as a word. It is ~157 KB against the
    // model's 483 KB and loads alongside it, so it costs no perceptible wait —
    // typing was already gated on the model arriving. A failed load degrades to
    // accepting everything rather than accepting nothing: a room that refuses
    // every word is broken in a way a room that is briefly permissive is not.
    loadLexicon().catch((error: unknown): null => {
      debug("ml", "lexicon unavailable, accepting any word", error);
      return null;
    }),
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
   * The cursor's position in world units — where the next word forms and lands.
   *
   * It follows the mouse in **both** axes, clamped so a word cannot form
   * half-off the frame. DESIGN.md's original centred, fixed cursor was changed
   * in Phase 2 to follow the mouse in x; this is the other half of that move.
   * Placing words is how the room is composed, and a room composed only along a
   * line is a shelf rather than a space. There is deliberately no vertical
   * clamp beyond the frame: placing low is setting a word down rather than
   * dropping it, which is a gesture worth having.
   */
  const CURSOR_EDGE_MARGIN_UNITS = 0.5;
  let cursorX = 0;
  let cursorY = 0;
  window.addEventListener("mousemove", (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const limitX = Math.max(0, room.roomWidth / 2 - CURSOR_EDGE_MARGIN_UNITS);
    const limitY = Math.max(0, room.roomHeight / 2 - CURSOR_EDGE_MARGIN_UNITS);
    const fractionX = (event.clientX - rect.left) / rect.width;
    // Screen y grows downward and world y grows up, so this is a flip rather
    // than the same expression twice.
    const fractionY = (event.clientY - rect.top) / rect.height;
    cursorX = Math.max(
      -limitX,
      Math.min(limitX, (fractionX - 0.5) * room.roomWidth),
    );
    cursorY = Math.max(
      -limitY,
      Math.min(limitY, (0.5 - fractionY) * room.roomHeight),
    );
  });

  /**
   * The word being typed, kept here as well as in the renderer because the safe
   * zone needs to know how big it is.
   */
  let draftOutline: WordOutline | null = null;

  /**
   * The footprint the safe zone probes with when nothing is being typed, in em
   * — roughly the caret's own box. Without it an empty buffer probes with a
   * zero-width word and the caret dips into every gap between letters instead
   * of riding the pile's surface.
   */
  const EMPTY_CARET_WIDTH_EM = 0.06;
  const EMPTY_CARET_HEIGHT_EM = 0.72;

  /**
   * Where the next word is actually released: the cursor, lifted clear of
   * whatever is already standing in that column.
   *
   * Recomputed once a frame rather than at commit, because the draft is drawn
   * here too — the visitor watches the caret climb the sediment as the pointer
   * sweeps across it, and then the word lands exactly where they were shown it
   * would. A correction applied only at commit would read as teleporting.
   */
  let spawnY = 0;
  function updateSpawn(): void {
    const widthEm = draftOutline?.width ?? EMPTY_CARET_WIDTH_EM;
    const heightEm = draftOutline?.height ?? EMPTY_CARET_HEIGHT_EM;
    spawnY = room.safeSpawnY(cursorX, widthEm / 2, heightEm / 2, cursorY);
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
      // The room's own policy — currently just the soft cap.
      world.step();
    },
    render(): void {
      updateSpawn();
      renderer.render(
        room.bodies,
        room.roomWidth / 2,
        room.roomHeight / 2,
        WORD_EM_UNITS,
        cursorX,
        spawnY,
        world.tint(),
      );
    },
  });

  const world = createRoom(room, renderer, loop);

  // Physics pauses on *visibility*, not on window blur. DESIGN.md says blur and
  // gives the reason as background CPU burn — but blur also fires when the
  // window is merely not frontmost, which would freeze a room the visitor is
  // still watching on another monitor. Blur pauses the caret's pulse, which is
  // the part of the instruction that is genuinely about having the keyboard.
  document.addEventListener("visibilitychange", (): void => {
    world.onVisibilityChange(document.hidden);
  });
  window.addEventListener("focus", (): void => {
    world.onFocusChange(true);
  });
  window.addEventListener("blur", (): void => {
    world.onFocusChange(false);
  });

  // Clear. `input.ts` deliberately lets Cmd/Ctrl combinations through, so this
  // is the only listener that sees it.
  window.addEventListener("keydown", (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k")
      return;
    // Claimed even when the room is too empty to clear, so the browser's own
    // shortcut never fires over the piece.
    event.preventDefault();
    world.clear();
  });

  // The empty room is on screen from here. Everything below waits on the
  // network; nothing above it does.
  loop.start();
  debug(
    "loop",
    `room ${room.roomWidth.toFixed(1)} units wide, awaiting assets`,
  );

  const [glyphs, lexicon, properties] = await assets;

  attachWordInput(window, {
    onChange(buffer): void {
      // The uncommitted word renders at neutral axes, not at the axes its scores
      // imply. Per DESIGN.md the model's opinion arrives *on commit* — that is the
      // moment the commit spring exists to dramatise, and pre-empting it would
      // spend the effect before the word is a body.
      draftOutline =
        buffer.length === 0 ? null : glyphs.outlineFor(buffer, NEUTRAL_AXES);
      renderer.setDraft(draftOutline);
      // The word just changed size, so where it clears the pile has changed
      // too. Without this the caret lags a frame behind the letter you typed.
      updateSpawn();
    },
    onCommit(word): boolean {
      // Answered synchronously so the draft survives a refusal and shakes in
      // place. Only once the room has said yes is the draft cleared and the
      // word handed to inference.
      if (!canCommit(lexicon, word)) return false;
      // Read before the draft is cleared: this is the height the visitor was
      // just shown, computed against the word they actually typed.
      const releaseY = spawnY;
      // Cleared here rather than after inference resolves, so the draft does not
      // linger for a frame on top of the body that replaces it.
      draftOutline = null;
      renderer.setDraft(null);
      void commitWord(
        renderer,
        properties,
        glyphs,
        room,
        word,
        cursorX,
        releaseY,
      );
      return true;
    },
    onRejected(): void {
      renderer.shake();
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
      world,
      loop,
      glyphs,
      lexicon,
      properties,
      renderer,
      commit: (word: string, spawnX = cursorX, spawn = spawnY) =>
        commitWord(renderer, properties, glyphs, room, word, spawnX, spawn),
    };
  }
}
