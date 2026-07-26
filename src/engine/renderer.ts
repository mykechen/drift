import {
  Color,
  Geometry,
  Mesh,
  Program,
  Renderer,
  Texture,
  Transform,
} from "ogl";
import { BACKGROUND, INK } from "../design/palette";
import type { WordOutline, WordPath } from "./glyphs";
import type { WordBody } from "./physics";
import { createSdfBaker, SPREAD_EM, type SdfField } from "./sdf";
import { debug } from "../util/debug";

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

  varying vec2 vUv;

  void main() {
    float distance = texture2D(uField, vUv).r;
    float coverage = smoothstep(0.5 - uEdgeSoftness, 0.5 + uEdgeSoftness, distance);
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
  const ink = new Color(INK);
  const meshes = new Map<number, Mesh>();
  /** Words being crushed out of existence: mesh + when the animation started. */
  const crushing = new Map<number, { mesh: Mesh; startMs: number }>();
  /** The word being typed. One at a time, replaced wholesale on each keystroke. */
  let draft: Mesh | null = null;

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
          uInk: { value: [ink.r, ink.g, ink.b] },
          uAlpha: { value: 1 },
          uEdgeSoftness: { value: 0.1 },
        },
      }),
    });
  }

  function attach(body: WordBody): void {
    const { path, width, height } = body.geometry;
    const mesh = buildMesh(path, width, height);
    if (!mesh) return;
    mesh.setParent(scene);
    meshes.set(body.id, mesh);
  }

  function setDraft(outline: WordOutline | null): void {
    if (draft) {
      draft.setParent(null);
      draft = null;
    }
    if (!outline) return;
    draft = buildMesh(outline.path, outline.width, outline.height);
    if (draft) draft.setParent(scene);
  }

  function crush(id: number): void {
    const mesh = meshes.get(id);
    if (!mesh) return;
    meshes.delete(id);
    // The mesh keeps the transform the last frame gave it, so it presses flat
    // exactly where the word was sitting. performance.now is fine here — this is
    // wall-clock exit polish, not simulation.
    crushing.set(id, { mesh, startMs: performance.now() });
  }

  function detachAll(): void {
    for (const mesh of meshes.values()) mesh.setParent(null);
    meshes.clear();
    for (const { mesh } of crushing.values()) mesh.setParent(null);
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

      for (const body of bodies) {
        const mesh = meshes.get(body.id);
        if (!mesh) continue;
        const uniforms = mesh.program.uniforms;
        (uniforms["uTranslation"] as { value: number[] }).value = [
          body.x,
          body.y,
        ];
        (uniforms["uRotation"] as { value: number }).value = body.rotation;
        (uniforms["uScale"] as { value: number }).value = wordScale;
        (uniforms["uEdgeSoftness"] as { value: number }).value = edgeSoftness;
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
      }
      if (crushing.size > 0) {
        const now = performance.now();
        for (const [id, entry] of crushing) {
          const t = (now - entry.startMs) / CRUSH_FADE_MS;
          if (t >= 1) {
            entry.mesh.setParent(null);
            crushing.delete(id);
            continue;
          }
          const uniforms = entry.mesh.program.uniforms;
          // Press thin and spread slightly wide, fading as it flattens. Scale and
          // room extent are refreshed in case the room resized mid-crush.
          (uniforms["uSquash"] as { value: number[] }).value = [
            1 + 0.35 * t,
            Math.max(0.04, 1 - t),
          ];
          (uniforms["uAlpha"] as { value: number }).value = 1 - t;
          (uniforms["uScale"] as { value: number }).value = wordScale;
          (uniforms["uEdgeSoftness"] as { value: number }).value = edgeSoftness;
          (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
            roomHalfWidth,
            roomHalfHeight,
          ];
        }
      }

      if (draft) {
        const uniforms = draft.program.uniforms;
        // The draft is centred on the cursor — which follows the mouse in x —
        // rather than growing rightward from a caret, so it sits exactly where
        // the committed body will spawn (DESIGN.md: words land at the cursor).
        (uniforms["uTranslation"] as { value: number[] }).value = [cursorX, 0];
        (uniforms["uRotation"] as { value: number }).value = 0;
        (uniforms["uScale"] as { value: number }).value = wordScale;
        (uniforms["uEdgeSoftness"] as { value: number }).value = edgeSoftness;
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
      }

      renderer.render({ scene });
    },
  };
}
