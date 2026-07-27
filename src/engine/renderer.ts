import {
  Color,
  Geometry,
  Mesh,
  Program,
  Renderer,
  Texture,
  Transform,
} from "ogl";
import {
  ACCENT_CURSOR,
  BACKGROUND,
  inkForWarmth,
  SHADOW_BLUR_EM_HEAVIEST,
  SHADOW_BLUR_EM_LIGHTEST,
  SHADOW_COLOR,
  SHADOW_DROP_EM_HEAVIEST,
  SHADOW_DROP_EM_LIGHTEST,
  SHADOW_OPACITY,
  type RoomTint,
} from "../design/palette";
import { createBackground } from "./background";
import {
  COMMIT_SPRING,
  createSpring,
  SHAKE_DURATION_MS,
  shakeOffset,
  springAtRest,
  stepSpring,
  type Spring,
} from "../design/motion";
import {
  EDGE_EROSION_AT_OLDEST,
  EDGE_WEAR_AT_OLDEST,
  wearForAge,
} from "../design/typography";
import type { WordOutline, WordPath } from "./glyphs";
import type { WordBody } from "./physics";
import {
  FIRE_FLICKER_AMOUNT,
  FIRE_FLICKER_HZ,
  MATERIAL_FIRE,
  MATERIAL_NONE,
  materialFor,
  WATER_RIPPLE_AMOUNT,
  WATER_RIPPLE_HZ,
  WATER_RIPPLE_WAVES,
} from "../design/materials";
import { createSdfBaker, SPREAD_EM, type SdfField } from "./sdf";
import { debug } from "../util/debug";

/**
 * The ink of a word and the shadow it casts, drawn from one field.
 *
 * `shadow` is null for the in-progress word: per DESIGN.md there is no shadow
 * beneath the letters being typed. The draft is not a physical object yet, and
 * nothing that has not landed should look like it is resting on anything.
 */
interface WordMeshes {
  readonly ink: Mesh;
  readonly shadow: Mesh | null;
  /**
   * Kept so the ink can be rewritten when the time-of-day tint moves. `age`
   * rides along because it also feeds the ink now — an old word is faded toward
   * the paper, and the paper's colour moves with the hour.
   */
  readonly warmth: number;
  readonly age: number;
  /** Feeds the ink too: intensity sets how vivid the word's material is. */
  readonly intensity: number;
  /**
   * Where the shadow's blur and drop end up. The commit spring grows both from
   * nothing, so the settled values have to be remembered rather than written
   * once at build time.
   */
  readonly blurTarget: number;
  readonly dropTarget: number;
}

/** Map a score in [-1, 1] onto a range. */
function acrossMass(
  mass: number,
  atLightest: number,
  atHeaviest: number,
): number {
  const t = (Math.max(-1, Math.min(1, mass)) + 1) / 2;
  return atLightest + t * (atHeaviest - atLightest);
}

/** Retina is worth paying for; 3× displays are not. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/** How long a crushed word takes to press flat and fade. */
const CRUSH_FADE_MS = 320;

/**
 * The aging exit, per DESIGN.md: "2s ease-out, opacity + slight upward drift +
 * weight tapering to 300 as it goes. Read: the word is being forgotten, not
 * deleted."
 *
 * **The weight taper is deliberately not implemented.** Tapering `wght` to 300
 * over two seconds is the same per-frame axis change the commit spring rejected
 * and costs the same — a bake and a texture per axis quantum, for a word that
 * is on its way out. The scale-down stands in for it: a word that shrinks
 * slightly as it rises reads as receding, which is the same thought.
 */
const AGE_FADE_MS = 2000;
const AGE_DRIFT_EM = 0.35;
const AGE_SCALE_TO = 0.97;

/**
 * What the commit spring drives, and what it deliberately does not.
 *
 * DESIGN.md springs `wght` and `wdth` from neutral to the model's values. That
 * is not what happens, and the reason is in
 * `docs/specs/2026-07-27-phase-3-room-design.md`: geometry is cached at a
 * 5-unit axis quantum, so such a spring passes through ~11 distinct axis pairs,
 * each needing its own SDF bake (4.7ms) and its own texture (~15KB) that is
 * never read again. Eleven dropped frames and 33MB of dead textures across a
 * full room, for 180ms of animation.
 *
 * So the geometry is built once at the *target* axes — the axis mapping, which
 * is the load-bearing "the word IS the body" move, is untouched — and the
 * spring drives uniforms only. `uScale` gives the arrival its snap, and the
 * shadow's blur and drop grow in from nothing, which DESIGN.md's commit
 * sequence already asks for in as many words: "shadow appears and blurs to its
 * target radius."
 *
 * ROADMAP.md already forbids rebuilding colliders during the spring. This is
 * the same argument applied to the distance field.
 */
const COMMIT_SCALE_FROM = 0.92;
const COMMIT_SCALE_TO = 1;

/**
 * A word is one quad carrying its own distance field.
 *
 * This replaces Phase 2's flat fill of the word's triangulation. That fill had
 * a real virtue worth naming as it goes: the picture could not disagree with
 * the simulation, because both came from the same tessellation. The SDF gives
 * that up deliberately. Colliders stay coarse — a collision only needs a
 * silhouette that feels right — while the drawing gets the true quadratics, so
 * a counter is now round on screen and faceted in the solver. That divergence
 * is invisible at a 1/32 em flattening tolerance and it is the whole reason the
 * two pipelines were separated.
 */
const VERTEX_SHADER = /* glsl */ `
  attribute vec2 position;
  attribute vec2 uv;

  uniform vec2 uTranslation;
  uniform float uRotation;
  uniform float uScale;
  uniform vec2 uSquash;
  uniform vec2 uRoomHalfExtent;

  varying vec2 vUv;

  void main() {
    vUv = uv;
    float s = sin(uRotation);
    float c = cos(uRotation);
    // uSquash flattens the glyph in its own frame — used by the crush animation
    // to press a word thin (and spread it wide) before it fades.
    vec2 scaled = position * uScale * uSquash;
    vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
    vec2 world = rotated + uTranslation;
    gl_Position = vec4(world / uRoomHalfExtent, 0.0, 1.0);
  }
`;

/**
 * Threshold the field at its midpoint, softened by exactly one screen pixel.
 *
 * The softening width is handed in rather than taken from `fwidth`, which is
 * the usual way to do this. Derivatives are an extension under GLSL ES 1.00 and
 * the room already knows the answer exactly — it knows how many pixels an em
 * covers, because it chose the projection — so the uniform is both more
 * portable and more correct than asking the hardware to estimate it.
 */
const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform sampler2D uField;
  uniform vec3 uInk;
  uniform float uAlpha;
  uniform float uEdgeSoftness;
  // 0 for ink, the blur half-width in field units for a shadow. A shadow is the
  // same silhouette read with a wide ramp that starts at the letter's edge and
  // falls away outward, rather than a narrow one straddling it — which is what
  // makes it read as cast rather than as a fattened copy of the word.
  uniform float uBlur;
  // How eaten and how soft this word's edge is, from the model's age score.
  // Zero for a new word, and for every shadow — a worn word does not cast a
  // worn shadow, because wear is a property of the ink on the paper and the
  // shadow is a property of the light.
  uniform float uErode;
  uniform float uWear;
  // Animated materials, under test on exactly two words. 0 none, 1 fire,
  // 2 water. See src/design/materials.ts for why this is an experiment and not
  // a feature.
  uniform float uMaterial;
  uniform float uTime;
  uniform float uFlicker;
  uniform float uRipple;
  uniform float uRippleWaves;

  varying vec2 vUv;

  // Cheap value noise. Two hashes and a bilinear blend is enough for a flame
  // edge and costs a fraction of a gradient noise nobody would be able to tell
  // it from at this amplitude.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    vec2 uv = vUv;
    float erode = uErode;
    vec3 ink = uInk;

    // Water displaces where the field is *sampled*, so the letterform itself
    // appears to run rather than its edge being chewed. Vertical displacement
    // driven by a horizontal travelling wave, which is what reads as a surface
    // rather than as a wobble.
    if (uMaterial > 1.5) {
      uv.y += sin(uv.x * uRippleWaves + uTime) * uRipple;
    }

    float distance = texture2D(uField, uv).r;

    // Fire moves the threshold instead, which is the same knob age uses to
    // erode a word — so the edge burns back and forward unevenly while the
    // interior stays solid. Noise rises through the glyph over time, so the
    // flicker travels upward the way a flame does.
    if (uMaterial > 0.5 && uMaterial < 1.5) {
      float n = valueNoise(vec2(uv.x * 7.0, uv.y * 4.0 - uTime));
      erode += (n - 0.5) * uFlicker;
      // Hotter where the field says the edge is: the fringe of the letter
      // glows, the body of it stays ink.
      float fringe = 1.0 - smoothstep(0.5, 0.72, distance);
      ink = mix(ink, ink * vec3(1.9, 1.25, 0.6), fringe * n * 0.75);
    }

    // Pushing the threshold *up* eats into the letter: a texel now has to be
    // deeper inside the glyph to count as ink.
    float soft = uEdgeSoftness * (1.0 + uWear);
    float lower = uBlur > 0.0 ? 0.5 - 2.0 * uBlur : 0.5 + erode - soft;
    float upper = uBlur > 0.0 ? 0.5 : 0.5 + erode + soft;
    float coverage = smoothstep(lower, upper, distance);
    if (coverage <= 0.0) discard;
    gl_FragColor = vec4(ink, uAlpha * coverage);
  }
`;

/**
 * The caret: a plain rectangle in the accent, and the only accent-coloured
 * thing in the piece.
 *
 * Its own program rather than the word one with a blank field — it has no
 * texture, no distance function and no edge to soften, and giving it the word
 * shader would mean binding a texture every frame to sample a value it ignores.
 */
const CURSOR_VERTEX_SHADER = /* glsl */ `
  attribute vec2 position;

  uniform vec2 uTranslation;
  uniform vec2 uSize;
  uniform vec2 uRoomHalfExtent;

  void main() {
    vec2 world = position * uSize + uTranslation;
    gl_Position = vec4(world / uRoomHalfExtent, 0.0, 1.0);
  }
`;

const CURSOR_FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform vec3 uColour;
  uniform float uAlpha;

  void main() {
    gl_FragColor = vec4(uColour, uAlpha);
  }
`;

/** Caret proportions, in em, so it scales with the words rather than the screen. */
const CURSOR_HEIGHT_EM = 0.72;
const CURSOR_WIDTH_EM = 0.055;

/**
 * Clearance between the last letter and the caret, in em.
 *
 * Without it the caret's left half overlaps the word's bounding box and touches
 * the final glyph, which reads as a stray stroke rather than as a caret.
 */
const CURSOR_GAP_EM = 0.09;

/** DESIGN.md: 2s cycle, sine, opacity 60% → 100%. Never off. */
const CURSOR_PULSE_PERIOD_MS = 2000;
const CURSOR_ALPHA_MIN = 0.6;
const CURSOR_ALPHA_MAX = 1;

/**
 * Members are typed as function properties rather than methods because they are
 * closures with no `this` — they stay correct when passed as bare event
 * listeners.
 */
export interface RoomRenderer {
  /** Root of the scene graph. */
  readonly scene: Transform;
  /** Canvas width divided by height, for the physics room's proportions. */
  readonly aspect: () => number;
  /** Give a committed body a mesh built from its own triangulation. */
  readonly attach: (body: WordBody) => void;
  /**
   * Show the word being typed, at the cursor. Pass null to clear it.
   *
   * Rebuilt on every keystroke rather than transformed, because the shape of the
   * word genuinely changes with each letter. The old mesh is disposed each time;
   * one allocation per keystroke is nothing next to a frame.
   */
  readonly setDraft: (outline: WordOutline | null) => void;
  /**
   * Begin the crush exit for a word whose body physics has already removed: its
   * mesh presses flat and fades in place, then is disposed. A no-op if the id has
   * no live mesh.
   */
  readonly crush: (id: number) => void;
  /**
   * Begin the aging exit for a word physics has already released: it drifts
   * upward, shrinks slightly and fades over 2s, then is disposed.
   *
   * Read: the word is being forgotten, not deleted. The crush is the violent
   * exit; this is the quiet one. A no-op if the id has no live mesh.
   *
   * `delayMs` staggers the start and `durationMs` sets the length, which is
   * what the clear gesture uses to fade a whole room newest-last inside its own
   * budget. Aging and clearing are the same animation at two different speeds —
   * 2s when a single word is forgotten, faster when the whole room goes at
   * once — so the duration has to travel with the call rather than being a
   * constant here.
   */
  readonly fade: (id: number, delayMs?: number, durationMs?: number) => void;
  /**
   * Freeze or resume the caret's pulse.
   *
   * Per DESIGN.md the pulse stops when the window loses focus. It freezes at
   * whatever opacity it had rather than snapping to full — a caret that jumped
   * to solid on blur would draw the eye to the window you just left.
   */
  readonly setPulsePaused: (paused: boolean) => void;
  /**
   * The refusal gesture: a brief damped jitter on the draft word and the caret.
   *
   * DESIGN.md answers every refusal with the same "subtle shake" — a keystroke
   * past the length cap, backspace into an empty buffer, a word with a digit,
   * standalone punctuation — so this is one gesture rather than four.
   */
  readonly shake: () => void;
  /**
   * Advance the commit springs by one fixed timestep.
   *
   * Called from the loop's `step`, not from `render`, so a spring settles the
   * same way regardless of display refresh rate — the same reason the physics
   * runs on a fixed timestep.
   */
  readonly step: (fixedDeltaMs: number) => void;
  /** Drop every mesh, committed and draft. */
  readonly detachAll: () => void;
  /** Re-reads the canvas's CSS size and resizes the drawing buffer to match. */
  readonly resize: () => void;
  /**
   * Draw one frame. Body transforms are read here rather than pushed on every
   * step, because the simulation may take several steps between frames and only
   * the last one is ever seen.
   */
  readonly render: (
    bodies: readonly WordBody[],
    roomHalfWidth: number,
    roomHalfHeight: number,
    wordScale: number,
    cursorX: number,
    cursorY: number,
    tint: RoomTint,
  ) => void;
}

/** Creates the WebGL renderer for the room. */
export function createRoomRenderer(canvas: HTMLCanvasElement): RoomRenderer {
  const renderer = new Renderer({
    canvas,
    dpr: Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO),
    // The room is opaque paper, and 2D — no depth buffer needed. Alpha is on so
    // a word can fade when it ages out.
    alpha: false,
    depth: false,
    antialias: true,
  });
  const gl = renderer.gl;

  // Only ever seen if the background pass fails to compile — the paper quad
  // covers every pixel. Kept as the graceful fallback, and it is the declared
  // value rather than the time-shifted one deliberately: a room that failed to
  // draw its paper should look wrong in a recognisable way.
  const clearColour = new Color(BACKGROUND);
  gl.clearColor(clearColour.r, clearColour.g, clearColour.b, 1);

  const scene = new Transform();

  /**
   * The paper, then two word layers. The background is an *opaque* program and
   * the words are transparent ones, and OGL draws all opaque meshes before any
   * transparent one — so the paper is beneath everything regardless of the
   * order these are parented in.
   *
   * The two word layers exist so every shadow is drawn beneath every word
   * rather than beneath only its own. With the depth buffer off, draw order
   * *is* stacking order — one layer would let a word's shadow fall across the
   * letters of a neighbour committed before it.
   */
  const background = createBackground(gl, scene);
  const shadowLayer = new Transform();
  const inkLayer = new Transform();
  /**
   * The caret gets a third layer, above the ink, and it needs one.
   *
   * Parented into `inkLayer` it drew *before* every word — OGL keeps equal-depth
   * transparent meshes in traversal order, and the caret is created once at
   * startup while words are appended as they commit. Measured, the draft word
   * painted over it: 200 accent pixels fell to 22 as soon as anything was being
   * typed. A caret that the text can bury is not a caret.
   */
  const cursorLayer = new Transform();
  shadowLayer.setParent(scene);
  inkLayer.setParent(scene);
  cursorLayer.setParent(scene);

  /**
   * The tint the ink uniforms were last written at.
   *
   * A word's ink is written once, when it is built — but the time-of-day shift
   * moves the room's light under words that are already sitting there, so every
   * word's ink has to be rewritten when it changes. Identity comparison is
   * enough because `room.ts` builds one tint object per minute and hands the
   * same one back on every frame in between; this rewrites 200 uniforms once a
   * minute rather than every frame.
   */
  let currentTint: RoomTint | null = null;

  const shadow = new Color(SHADOW_COLOR);
  /** A word's two meshes: the ink, and the shadow it casts. */
  const meshes = new Map<number, WordMeshes>();
  /** Words being crushed out of existence: meshes + when the animation started. */
  const crushing = new Map<number, { meshes: WordMeshes; startMs: number }>();
  /**
   * Words still arriving. Retired the moment their spring settles — a full room
   * must not be stepping two hundred springs that have all stopped moving.
   */
  const committing = new Map<number, Spring>();
  /**
   * Words aging out: their meshes, where they were standing when physics let
   * go, and when the fade should start.
   *
   * The position is captured at the moment of release rather than read per
   * frame, because there is no body left to read it from — which is exactly why
   * this path needs no unfreezing. ROADMAP warned that "any upward drift during
   * fade-out needs them unfrozen first"; once physics has dropped the body,
   * there is nothing frozen to unfreeze.
   */
  const fading = new Map<
    number,
    {
      meshes: WordMeshes;
      startMs: number;
      durationMs: number;
      x: number;
      y: number;
      rotation: number;
    }
  >();
  /**
   * Words with an animated fill, and which one. Under test on two words; see
   * `src/design/materials.ts`.
   *
   * A map rather than a flag on `WordMeshes` because `render` needs to walk
   * *only* these — writing a time uniform to two hundred meshes every frame to
   * animate two of them is the kind of cost that hides until a full room.
   */
  const animating = new Map<number, { mesh: Mesh; material: number }>();
  /**
   * Seconds of animation, accumulated on the **fixed timestep** rather than
   * read from the wall clock — so a flame looks the same on a 60Hz laptop and a
   * 144Hz monitor, and freezes when the loop pauses on a hidden tab, exactly
   * like the physics and the springs.
   */
  let materialSeconds = 0;

  /** The word being typed. One at a time, replaced wholesale on each keystroke. */
  let draft: WordMeshes | null = null;
  /**
   * How wide the draft is, in em. The caret rides its right edge, so this is
   * the one thing about the draft the cursor needs to know.
   */
  let draftWidthEm = 0;

  const accent = new Color(ACCENT_CURSOR);
  const cursorMesh = new Mesh(gl, {
    geometry: new Geometry(gl, {
      position: {
        size: 2,
        data: new Float32Array([
          -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5,
        ]),
      },
    }),
    program: new Program(gl, {
      vertex: CURSOR_VERTEX_SHADER,
      fragment: CURSOR_FRAGMENT_SHADER,
      transparent: true,
      cullFace: false,
      uniforms: {
        uTranslation: { value: [0, 0] },
        uSize: { value: [1, 1] },
        uRoomHalfExtent: { value: [1, 1] },
        uColour: { value: [accent.r, accent.g, accent.b] },
        uAlpha: { value: CURSOR_ALPHA_MAX },
      },
    }),
  });
  cursorMesh.setParent(cursorLayer);

  /**
   * Pulse phase, carried across frames rather than read from `performance.now()`
   * directly, so that pausing freezes the caret where it is instead of letting
   * the clock run on underneath and jumping when it resumes.
   */
  let pulseMs = 0;
  let pulsePaused = false;
  let lastPulseSampleMs = performance.now();

  /**
   * When the current refusal shake began, or null if nothing is being refused.
   * Wall-clock like the pulse — it is feedback about an input event, not part
   * of the simulation.
   */
  let shakeStartedMs: number | null = null;

  /**
   * OGL's `setSize` writes inline `width`/`height` pixel styles onto the canvas
   * element, which would override the aspect clamp in style.css and pin the
   * room to whatever size it was last given — including the 300x150 the
   * Renderer constructor applies before we ever measure. The stylesheet owns
   * the element box; only the drawing buffer is ours to set.
   */
  function releaseInlineSize(): void {
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
  }

  function resize(): void {
    releaseInlineSize();

    // Measured after the inline styles are gone, so these reflect the CSS
    // aspect clamp rather than the last buffer size.
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    renderer.setSize(width, height);
    releaseInlineSize();

    debug("render", "resize", width, height, `dpr=${renderer.dpr}`);
  }

  /**
   * Fields are cached against the `WordPath` object rather than a string key.
   *
   * `geometryFor` and `outlineFor` already cache by word, axes and tolerance and
   * hand back the same object every time, so object identity *is* the cache key
   * — the same path can only ever mean the same field. It also means the key can
   * never drift out of step with what it names, which a hand-built
   * `word|wght|wdth` string eventually would.
   */
  const fields = new Map<WordPath, { texture: Texture; field: SdfField }>();
  const baker = createSdfBaker();

  // Field rows are one byte per texel and a word's width is rarely a multiple
  // of four, so the default four-byte row alignment would shear every texture.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  function fieldFor(
    path: WordPath,
    emWidth: number,
    emHeight: number,
  ): { texture: Texture; field: SdfField } | null {
    const cached = fields.get(path);
    if (cached) return cached;

    const field = baker.bake(path, emWidth, emHeight);
    if (!field) return null;

    const texture = new Texture(gl, {
      image: field.data,
      width: field.width,
      height: field.height,
      format: gl.LUMINANCE,
      internalFormat: gl.LUMINANCE,
      type: gl.UNSIGNED_BYTE,
      // Linear filtering is the point: sampling between texels is what lets the
      // field describe an edge finer than its own grid.
      minFilter: gl.LINEAR,
      magFilter: gl.LINEAR,
      // The field carries its own spread margin, so it never samples past its
      // edge — but clamping means a sample that does lands on paper, not on the
      // opposite side of the word.
      wrapS: gl.CLAMP_TO_EDGE,
      wrapT: gl.CLAMP_TO_EDGE,
      generateMipmaps: false,
      flipY: false,
    });

    const entry = { texture, field };
    fields.set(path, entry);
    return entry;
  }

  function buildMesh(
    path: WordPath,
    emWidth: number,
    emHeight: number,
  ): Mesh | null {
    const entry = fieldFor(path, emWidth, emHeight);
    if (!entry) return null;

    // The quad is the field's extent, not the word's: the field is wider by its
    // spread margin on every side, and the two must line up texel for texel.
    const halfWidth = entry.field.emWidth / 2;
    const halfHeight = entry.field.emHeight / 2;

    return new Mesh(gl, {
      geometry: new Geometry(gl, {
        position: {
          size: 2,
          data: new Float32Array([
            -halfWidth,
            halfHeight,
            halfWidth,
            halfHeight,
            halfWidth,
            -halfHeight,
            -halfWidth,
            halfHeight,
            halfWidth,
            -halfHeight,
            -halfWidth,
            -halfHeight,
          ]),
        },
        // v grows downward to match the field's row order, which is top row
        // first because that is how a canvas rasterises.
        uv: {
          size: 2,
          data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
        },
      }),
      program: new Program(gl, {
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        transparent: true,
        cullFace: false,
        uniforms: {
          uField: { value: entry.texture },
          uTranslation: { value: [0, 0] },
          uRotation: { value: 0 },
          // Set per frame from the room's own scale, so a mesh's em units land
          // at the same size the colliders were built at.
          uScale: { value: 1 },
          // [x, y] multiplier, 1 until the word is being crushed flat.
          uSquash: { value: [1, 1] },
          uRoomHalfExtent: { value: [1, 1] },
          uInk: { value: [0, 0, 0] },
          uAlpha: { value: 1 },
          uEdgeSoftness: { value: 0.1 },
          uBlur: { value: 0 },
          uErode: { value: 0 },
          uWear: { value: 0 },
          // Animated materials, under test. Zero on everything but the two
          // words in src/design/materials.ts, and on every shadow — a burning
          // word does not cast a burning shadow, for the same reason a worn one
          // does not cast a worn shadow.
          uMaterial: { value: MATERIAL_NONE },
          uTime: { value: 0 },
          uFlicker: { value: FIRE_FLICKER_AMOUNT },
          uRipple: { value: WATER_RIPPLE_AMOUNT },
          uRippleWaves: { value: WATER_RIPPLE_WAVES },
        },
      }),
    });
  }

  /**
   * Build a word's ink and its shadow.
   *
   * Both read the same field — the shadow costs one extra quad and no extra
   * texture, which is why `SPREAD_EM` was made wide enough to hold a blur in the
   * first place. `mass` sets the blur and the drop; `warmth` sets the ink's hue.
   */
  function buildWord(
    path: WordPath,
    emWidth: number,
    emHeight: number,
    mass: number,
    warmth: number,
    age: number,
    intensity: number,
    castsShadow: boolean,
  ): WordMeshes | null {
    const inkMesh = buildMesh(path, emWidth, emHeight);
    if (!inkMesh) return null;

    (inkMesh.program.uniforms["uInk"] as { value: number[] }).value =
      inkForWarmth(warmth, currentTint ?? undefined, age, intensity);
    // Wear is written once — `age` never changes for a committed word, unlike
    // the tint, which is why this needs no per-frame refresh.
    const wear = wearForAge(age);
    (inkMesh.program.uniforms["uErode"] as { value: number }).value =
      wear * EDGE_EROSION_AT_OLDEST;
    (inkMesh.program.uniforms["uWear"] as { value: number }).value =
      wear * EDGE_WEAR_AT_OLDEST;
    inkMesh.setParent(inkLayer);

    const bare = {
      ink: inkMesh,
      shadow: null,
      warmth,
      age,
      intensity,
      blurTarget: 0,
      dropTarget: 0,
    };
    if (!castsShadow) return bare;

    const shadowMesh = buildMesh(path, emWidth, emHeight);
    if (!shadowMesh) return bare;

    const blurEm = acrossMass(
      mass,
      SHADOW_BLUR_EM_LIGHTEST,
      SHADOW_BLUR_EM_HEAVIEST,
    );
    const shadowUniforms = shadowMesh.program.uniforms;
    (shadowUniforms["uInk"] as { value: number[] }).value = [
      shadow.r,
      shadow.g,
      shadow.b,
    ];
    (shadowUniforms["uAlpha"] as { value: number }).value = SHADOW_OPACITY;
    // The field spans 2×SPREAD_EM across its full range, so an em converts to
    // field units by dividing by that. Written per frame while the commit
    // spring runs, so it starts at zero — a shadow that appeared at full radius
    // would arrive before the word had finished landing.
    const blurTarget = blurEm / (2 * SPREAD_EM);
    (shadowUniforms["uBlur"] as { value: number }).value = 0;

    shadowMesh.setParent(shadowLayer);
    return {
      ink: inkMesh,
      shadow: shadowMesh,
      warmth,
      age,
      intensity,
      blurTarget,
      dropTarget: shadowDropFor(mass),
    };
  }

  /**
   * Rewrite every word's ink for a new time of day.
   *
   * Words already in the room are lit by the same light as new ones — the shift
   * is a property of the room, not of the moment a word was committed.
   */
  function relightInk(tint: RoomTint): void {
    for (const pair of meshes.values()) {
      (pair.ink.program.uniforms["uInk"] as { value: number[] }).value =
        inkForWarmth(pair.warmth, tint, pair.age, pair.intensity);
    }
    for (const entry of crushing.values()) {
      (entry.meshes.ink.program.uniforms["uInk"] as { value: number[] }).value =
        inkForWarmth(
          entry.meshes.warmth,
          tint,
          entry.meshes.age,
          entry.meshes.intensity,
        );
    }
    for (const entry of fading.values()) {
      (entry.meshes.ink.program.uniforms["uInk"] as { value: number[] }).value =
        inkForWarmth(
          entry.meshes.warmth,
          tint,
          entry.meshes.age,
          entry.meshes.intensity,
        );
    }
    if (draft) {
      (draft.ink.program.uniforms["uInk"] as { value: number[] }).value =
        inkForWarmth(draft.warmth, tint, draft.age, draft.intensity);
    }
  }

  /** How far below the word its shadow falls, in em. */
  function shadowDropFor(mass: number): number {
    return acrossMass(mass, SHADOW_DROP_EM_LIGHTEST, SHADOW_DROP_EM_HEAVIEST);
  }

  function detach(pair: WordMeshes): void {
    pair.ink.setParent(null);
    pair.shadow?.setParent(null);
  }

  function attach(body: WordBody): void {
    const { path, width, height } = body.geometry;
    const pair = buildWord(
      path,
      width,
      height,
      body.scores.mass,
      body.scores.warmth,
      body.scores.age,
      body.scores.intensity,
      true,
    );
    if (!pair) return;
    meshes.set(body.id, pair);

    // Only the ink. A burning word does not cast a burning shadow, for the same
    // reason a worn one does not cast a worn shadow: the material belongs to
    // the ink on the paper and the shadow belongs to the light.
    const material = materialFor(body.word);
    if (material !== MATERIAL_NONE) {
      (pair.ink.program.uniforms["uMaterial"] as { value: number }).value =
        material;
      animating.set(body.id, { mesh: pair.ink, material });
    }

    committing.set(
      body.id,
      createSpring(COMMIT_SPRING, COMMIT_SCALE_FROM, COMMIT_SCALE_TO),
    );
  }

  function setDraft(outline: WordOutline | null): void {
    if (draft) {
      detach(draft);
      draft = null;
    }
    if (!outline) {
      draftWidthEm = 0;
      return;
    }
    // The uncommitted word renders at neutral axes, so it gets neutral ink —
    // the model's opinion arrives on commit, and that includes its opinion
    // about colour. No shadow, per DESIGN.md.
    // The draft is neutral in every axis the model has an opinion about,
    // including age — its opinion arrives on commit.
    draft = buildWord(
      outline.path,
      outline.width,
      outline.height,
      0,
      0,
      0,
      0,
      false,
    );
    draftWidthEm = outline.width;
  }

  function crush(id: number): void {
    const pair = meshes.get(id);
    if (!pair) return;
    meshes.delete(id);
    animating.delete(id);
    // A word crushed mid-arrival stops arriving. Without this its spring keeps
    // stepping against a mesh the crush animation now owns, and the two fight
    // over `uScale`.
    committing.delete(id);
    // The meshes keep the transform the last frame gave them, so the word
    // presses flat exactly where it was sitting. performance.now is fine here —
    // this is wall-clock exit polish, not simulation.
    crushing.set(id, { meshes: pair, startMs: performance.now() });
  }

  function fade(id: number, delayMs = 0, durationMs = AGE_FADE_MS): void {
    const pair = meshes.get(id);
    if (!pair) return;
    meshes.delete(id);
    committing.delete(id);
    animating.delete(id);

    // Where the word was standing, read back from the transform the last frame
    // gave it. There is no body to ask any more — physics released it before
    // this was called — and the mesh is the only remaining record of where it
    // sat.
    const translation = (
      pair.ink.program.uniforms["uTranslation"] as { value: number[] }
    ).value;
    const rotation = (
      pair.ink.program.uniforms["uRotation"] as { value: number }
    ).value;

    fading.set(id, {
      meshes: pair,
      startMs: performance.now() + delayMs,
      durationMs,
      x: translation[0] ?? 0,
      y: translation[1] ?? 0,
      rotation,
    });
  }

  /** Decelerating, per DESIGN.md's "2s ease-out". */
  function easeOut(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  function step(fixedDeltaMs: number): void {
    materialSeconds += fixedDeltaMs / 1000;
    if (committing.size === 0) return;
    for (const [id, spring] of committing) {
      stepSpring(spring, fixedDeltaMs);
      if (springAtRest(spring)) committing.delete(id);
    }
  }

  function detachAll(): void {
    for (const pair of meshes.values()) detach(pair);
    meshes.clear();
    committing.clear();
    animating.clear();
    for (const entry of crushing.values()) detach(entry.meshes);
    crushing.clear();
    for (const entry of fading.values()) detach(entry.meshes);
    fading.clear();
    setDraft(null);
  }

  // Before anything reads the canvas. The Renderer constructor writes a 300x150
  // inline size onto the element, and until that is cleared `clientWidth` and
  // `clientHeight` report it rather than the CSS box — which silently sizes the
  // drawing buffer *and* the physics room's aspect ratio to 2:1. This same
  // omission cost a debugging session in Phase 0; it is one call and it belongs
  // here, not at the call site.
  resize();

  return {
    scene,
    aspect: (): number => canvas.clientWidth / Math.max(canvas.clientHeight, 1),
    attach,
    setDraft,
    crush,
    fade,
    step,
    setPulsePaused(paused: boolean): void {
      // Resample the clock on resume so the time spent paused is not counted as
      // pulse phase; without this the caret jumps to wherever the sine would
      // have been had it kept running.
      if (pulsePaused && !paused) lastPulseSampleMs = performance.now();
      pulsePaused = paused;
    },
    shake(): void {
      // Restarted rather than queued: hold a key down past the cap and the
      // gesture should stay one continuous shudder, not a backlog of them.
      shakeStartedMs = performance.now();
    },
    detachAll,
    resize,
    render(
      bodies: readonly WordBody[],
      roomHalfWidth: number,
      roomHalfHeight: number,
      wordScale: number,
      cursorX: number,
      cursorY: number,
      tint: RoomTint,
    ): void {
      background.draw(tint);
      if (tint !== currentTint) {
        currentTint = tint;
        relightInk(tint);
      }

      // How soft the ink edge should be, in field units, so that it covers
      // exactly one device pixel. The room half-height in world units maps to
      // half the drawing buffer, an em is `wordScale` world units, and the field
      // spans 2×SPREAD_EM across its full 0–1 range — so this is a pure unit
      // conversion the renderer can do exactly, no derivatives required.
      const pixelsPerWorldUnit = gl.drawingBufferHeight / (roomHalfHeight * 2);
      const pixelsPerEm = pixelsPerWorldUnit * wordScale;
      const edgeSoftness =
        pixelsPerEm > 0 ? 1 / pixelsPerEm / (2 * SPREAD_EM) : 0.1;

      /**
       * Point one mesh at a place in the room. The shadow gets the same
       * transform as its word plus a downward drop, so it stays put under a
       * word that tumbles — a shadow that rotated with the letters would read as
       * a second word lying behind the first rather than as light falling.
       */
      function place(
        mesh: Mesh,
        x: number,
        y: number,
        rotation: number,
        drop: number,
        scaleMultiplier = 1,
      ): void {
        const uniforms = mesh.program.uniforms;
        (uniforms["uTranslation"] as { value: number[] }).value = [
          x,
          y - drop * wordScale,
        ];
        (uniforms["uRotation"] as { value: number }).value = rotation;
        (uniforms["uScale"] as { value: number }).value =
          wordScale * scaleMultiplier;
        (uniforms["uEdgeSoftness"] as { value: number }).value = edgeSoftness;
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
      }

      for (const body of bodies) {
        const pair = meshes.get(body.id);
        if (!pair) continue;

        // The commit spring, if this word is still arriving. `arrival` runs 0 →
        // 1 as the spring travels, overshooting a little past 1 — which is the
        // point of it. A settled word has no spring and takes the plain path.
        const spring = committing.get(body.id);
        const scale = spring ? spring.value : COMMIT_SCALE_TO;
        const arrival = spring
          ? (spring.value - COMMIT_SCALE_FROM) /
            (COMMIT_SCALE_TO - COMMIT_SCALE_FROM)
          : 1;

        place(pair.ink, body.x, body.y, body.rotation, 0, scale);
        if (pair.shadow) {
          place(
            pair.shadow,
            body.x,
            body.y,
            body.rotation,
            pair.dropTarget * arrival,
            scale,
          );
          // Written unconditionally rather than only while a spring exists, so
          // the frame after one retires lands exactly on the target instead of
          // keeping whatever the last spring step left behind.
          (pair.shadow.program.uniforms["uBlur"] as { value: number }).value =
            pair.blurTarget * arrival;
        }
      }

      // Only the words under test, and only their ink. Fire scrolls its noise
      // upward through the glyph; water travels a wave along it, so the two
      // want their own rates rather than one shared clock.
      for (const entry of animating.values()) {
        const rate =
          entry.material === MATERIAL_FIRE
            ? materialSeconds * FIRE_FLICKER_HZ
            : materialSeconds * WATER_RIPPLE_HZ * 2 * Math.PI;
        (entry.mesh.program.uniforms["uTime"] as { value: number }).value =
          rate;
      }

      if (fading.size > 0) {
        const now = performance.now();
        for (const [id, entry] of fading) {
          // Staggered fades sit at a negative elapsed until their turn comes.
          // Until then they hold still at full opacity, which is what makes the
          // clear gesture read as a wave rather than as everything dimming at
          // once.
          const elapsed = now - entry.startMs;
          const t = Math.max(0, elapsed / entry.durationMs);
          if (t >= 1) {
            detach(entry.meshes);
            fading.delete(id);
            continue;
          }
          const eased = easeOut(t);
          const scale = 1 + (AGE_SCALE_TO - 1) * eased;
          // Upward drift: the word rises as it is forgotten.
          const y = entry.y + AGE_DRIFT_EM * eased * wordScale;

          // Motion eases out; opacity does not, and the difference matters.
          // Running opacity through the same curve leaves the word 87.5% gone
          // at the halfway point — measured, it stopped registering at all
          // after about 1s of a 2s fade, so the back half of the drift was
          // spent on something invisible. Linear opacity makes the specified
          // two seconds the duration you actually see.
          place(entry.meshes.ink, entry.x, y, entry.rotation, 0, scale);
          (
            entry.meshes.ink.program.uniforms["uAlpha"] as { value: number }
          ).value = 1 - t;

          if (entry.meshes.shadow) {
            place(
              entry.meshes.shadow,
              entry.x,
              y,
              entry.rotation,
              entry.meshes.dropTarget,
              scale,
            );
            (
              entry.meshes.shadow.program.uniforms["uAlpha"] as {
                value: number;
              }
            ).value = SHADOW_OPACITY * (1 - t);
          }
        }
      }

      if (crushing.size > 0) {
        const now = performance.now();
        for (const [id, entry] of crushing) {
          const t = (now - entry.startMs) / CRUSH_FADE_MS;
          if (t >= 1) {
            detach(entry.meshes);
            crushing.delete(id);
            continue;
          }
          // Press thin and spread slightly wide, fading as it flattens. Scale and
          // room extent are refreshed in case the room resized mid-crush.
          const squash = [1 + 0.35 * t, Math.max(0.04, 1 - t)];
          const both = entry.meshes.shadow
            ? [entry.meshes.shadow, entry.meshes.ink]
            : [entry.meshes.ink];
          for (const mesh of both) {
            const uniforms = mesh.program.uniforms;
            (uniforms["uSquash"] as { value: number[] }).value = squash;
            (uniforms["uScale"] as { value: number }).value = wordScale;
            (uniforms["uEdgeSoftness"] as { value: number }).value =
              edgeSoftness;
            (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
              roomHalfWidth,
              roomHalfHeight,
            ];
          }
          const inkAlpha = entry.meshes.ink.program.uniforms["uAlpha"] as {
            value: number;
          };
          inkAlpha.value = 1 - t;
          if (entry.meshes.shadow) {
            const shadowAlpha = entry.meshes.shadow.program.uniforms[
              "uAlpha"
            ] as { value: number };
            shadowAlpha.value = SHADOW_OPACITY * (1 - t);
          }
        }
      }

      // The refusal shake displaces the draft and the caret together, so they
      // read as one object being refused rather than two things twitching.
      let shakeX = 0;
      if (shakeStartedMs !== null) {
        const elapsed = performance.now() - shakeStartedMs;
        if (elapsed >= SHAKE_DURATION_MS) shakeStartedMs = null;
        else shakeX = shakeOffset(elapsed) * wordScale;
      }

      if (draft) {
        // The draft is centred on the cursor — which follows the mouse in both
        // axes — rather than growing rightward from a caret, so it sits exactly
        // where the committed body will spawn (DESIGN.md: words land at the
        // cursor). `cursorY` arrives already lifted clear of the pile by the
        // safe zone, so what is drawn is what will be dropped.
        place(draft.ink, cursorX + shakeX, cursorY, 0, 0);
      }

      // The caret rides the *right edge* of the draft rather than sitting on
      // `cursorX`. The draft is centred there, so a caret at the cursor itself
      // would be behind the letters; at the right edge it behaves like a caret,
      // moving out as the word grows. With an empty buffer the width is zero and
      // it lands back on the cursor.
      {
        const nowMs = performance.now();
        if (!pulsePaused) pulseMs += nowMs - lastPulseSampleMs;
        lastPulseSampleMs = nowMs;

        // Sine mapped to [0, 1] then onto the opacity range: never off, per
        // DESIGN.md.
        const phase = (pulseMs / CURSOR_PULSE_PERIOD_MS) * 2 * Math.PI;
        const alpha =
          CURSOR_ALPHA_MIN +
          (CURSOR_ALPHA_MAX - CURSOR_ALPHA_MIN) * (0.5 + 0.5 * Math.sin(phase));

        const uniforms = cursorMesh.program.uniforms;
        // The gap only applies once there is a word to clear; with an empty
        // buffer the caret sits exactly on the cursor, where the next word will
        // form.
        const offsetEm =
          draftWidthEm > 0 ? draftWidthEm / 2 + CURSOR_GAP_EM : 0;
        (uniforms["uTranslation"] as { value: number[] }).value = [
          cursorX + offsetEm * wordScale + shakeX,
          cursorY,
        ];
        (uniforms["uSize"] as { value: number[] }).value = [
          CURSOR_WIDTH_EM * wordScale,
          CURSOR_HEIGHT_EM * wordScale,
        ];
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
        (uniforms["uAlpha"] as { value: number }).value = alpha;
      }

      renderer.render({ scene });
    },
  };
}
