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
  BACKGROUND,
  inkForWarmth,
  SHADOW_BLUR_EM_HEAVIEST,
  SHADOW_BLUR_EM_LIGHTEST,
  SHADOW_COLOR,
  SHADOW_DROP_EM_HEAVIEST,
  SHADOW_DROP_EM_LIGHTEST,
  SHADOW_OPACITY,
} from "../design/palette";
import type { WordOutline, WordPath } from "./glyphs";
import type { WordBody } from "./physics";
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

  varying vec2 vUv;

  void main() {
    float distance = texture2D(uField, vUv).r;
    float lower = uBlur > 0.0 ? 0.5 - 2.0 * uBlur : 0.5 - uEdgeSoftness;
    float upper = uBlur > 0.0 ? 0.5 : 0.5 + uEdgeSoftness;
    float coverage = smoothstep(lower, upper, distance);
    if (coverage <= 0.0) discard;
    gl_FragColor = vec4(uInk, uAlpha * coverage);
  }
`;

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

  const background = new Color(BACKGROUND);
  gl.clearColor(background.r, background.g, background.b, 1);

  const scene = new Transform();

  /**
   * Two layers, so every shadow is drawn beneath every word rather than beneath
   * only its own. With the depth buffer off, draw order *is* stacking order —
   * one layer would let a word's shadow fall across the letters of a neighbour
   * committed before it.
   */
  const shadowLayer = new Transform();
  const inkLayer = new Transform();
  shadowLayer.setParent(scene);
  inkLayer.setParent(scene);

  const shadow = new Color(SHADOW_COLOR);
  /** A word's two meshes: the ink, and the shadow it casts. */
  const meshes = new Map<number, WordMeshes>();
  /** Words being crushed out of existence: meshes + when the animation started. */
  const crushing = new Map<number, { meshes: WordMeshes; startMs: number }>();
  /** The word being typed. One at a time, replaced wholesale on each keystroke. */
  let draft: WordMeshes | null = null;

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
    castsShadow: boolean,
  ): WordMeshes | null {
    const inkMesh = buildMesh(path, emWidth, emHeight);
    if (!inkMesh) return null;

    const tint = inkForWarmth(warmth);
    (inkMesh.program.uniforms["uInk"] as { value: number[] }).value = tint;
    inkMesh.setParent(inkLayer);

    if (!castsShadow) return { ink: inkMesh, shadow: null };

    const shadowMesh = buildMesh(path, emWidth, emHeight);
    if (!shadowMesh) return { ink: inkMesh, shadow: null };

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
    // field units by dividing by that.
    (shadowUniforms["uBlur"] as { value: number }).value =
      blurEm / (2 * SPREAD_EM);

    shadowMesh.setParent(shadowLayer);
    return { ink: inkMesh, shadow: shadowMesh };
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
      true,
    );
    if (!pair) return;
    meshes.set(body.id, pair);
  }

  function setDraft(outline: WordOutline | null): void {
    if (draft) {
      detach(draft);
      draft = null;
    }
    if (!outline) return;
    // The uncommitted word renders at neutral axes, so it gets neutral ink —
    // the model's opinion arrives on commit, and that includes its opinion
    // about colour. No shadow, per DESIGN.md.
    draft = buildWord(outline.path, outline.width, outline.height, 0, 0, false);
  }

  function crush(id: number): void {
    const pair = meshes.get(id);
    if (!pair) return;
    meshes.delete(id);
    // The meshes keep the transform the last frame gave them, so the word
    // presses flat exactly where it was sitting. performance.now is fine here —
    // this is wall-clock exit polish, not simulation.
    crushing.set(id, { meshes: pair, startMs: performance.now() });
  }

  function detachAll(): void {
    for (const pair of meshes.values()) detach(pair);
    meshes.clear();
    for (const entry of crushing.values()) detach(entry.meshes);
    crushing.clear();
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
    detachAll,
    resize,
    render(
      bodies: readonly WordBody[],
      roomHalfWidth: number,
      roomHalfHeight: number,
      wordScale: number,
      cursorX: number,
    ): void {
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
      ): void {
        const uniforms = mesh.program.uniforms;
        (uniforms["uTranslation"] as { value: number[] }).value = [
          x,
          y - drop * wordScale,
        ];
        (uniforms["uRotation"] as { value: number }).value = rotation;
        (uniforms["uScale"] as { value: number }).value = wordScale;
        (uniforms["uEdgeSoftness"] as { value: number }).value = edgeSoftness;
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
      }

      for (const body of bodies) {
        const pair = meshes.get(body.id);
        if (!pair) continue;
        place(pair.ink, body.x, body.y, body.rotation, 0);
        if (pair.shadow) {
          place(
            pair.shadow,
            body.x,
            body.y,
            body.rotation,
            shadowDropFor(body.scores.mass),
          );
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

      if (draft) {
        // The draft is centred on the cursor — which follows the mouse in x —
        // rather than growing rightward from a caret, so it sits exactly where
        // the committed body will spawn (DESIGN.md: words land at the cursor).
        place(draft.ink, cursorX, 0, 0, 0);
      }

      renderer.render({ scene });
    },
  };
}
