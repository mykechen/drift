import { Color, Geometry, Mesh, Program, Renderer, Transform } from "ogl";
import { BACKGROUND, INK } from "../design/palette";
import type { WordOutline } from "./glyphs";
import type { WordBody } from "./physics";
import { debug } from "../util/debug";

/** Retina is worth paying for; 3× displays are not. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * Flat fill of the word's own triangulation.
 *
 * Deliberately not the final rendering — Phase 3 replaces this with an SDF that
 * draws the true curves. Until then the word is drawn from exactly the
 * tessellation its colliders were cut from, which means the picture cannot
 * disagree with the simulation. A counter that looks filled *is* filled.
 */
const VERTEX_SHADER = /* glsl */ `
  attribute vec2 position;

  uniform vec2 uTranslation;
  uniform float uRotation;
  uniform float uScale;
  uniform vec2 uRoomHalfExtent;

  void main() {
    float s = sin(uRotation);
    float c = cos(uRotation);
    vec2 scaled = position * uScale;
    vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
    vec2 world = rotated + uTranslation;
    gl_Position = vec4(world / uRoomHalfExtent, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;
  uniform vec3 uInk;
  uniform float uAlpha;

  void main() {
    gl_FragColor = vec4(uInk, uAlpha);
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

  function buildMesh(positions: Float32Array): Mesh {
    return new Mesh(gl, {
      geometry: new Geometry(gl, {
        position: { size: 2, data: positions },
      }),
      program: new Program(gl, {
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        transparent: true,
        cullFace: false,
        uniforms: {
          uTranslation: { value: [0, 0] },
          uRotation: { value: 0 },
          // Set per frame from the room's own scale, so a mesh's em units land
          // at the same size the colliders were built at.
          uScale: { value: 1 },
          uRoomHalfExtent: { value: [1, 1] },
          uInk: { value: [ink.r, ink.g, ink.b] },
          uAlpha: { value: 1 },
        },
      }),
    });
  }

  function attach(body: WordBody): void {
    const positions = body.geometry.triangles;
    if (positions.length === 0) return;
    const mesh = buildMesh(positions);
    mesh.setParent(scene);
    meshes.set(body.id, mesh);
  }

  function setDraft(outline: WordOutline | null): void {
    if (draft) {
      draft.setParent(null);
      draft = null;
    }
    if (!outline || outline.triangles.length === 0) return;
    draft = buildMesh(outline.triangles);
    draft.setParent(scene);
  }

  function detachAll(): void {
    for (const mesh of meshes.values()) mesh.setParent(null);
    meshes.clear();
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
    detachAll,
    resize,
    render(
      bodies: readonly WordBody[],
      roomHalfWidth: number,
      roomHalfHeight: number,
      wordScale: number,
    ): void {
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
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
      }
      if (draft) {
        const uniforms = draft.program.uniforms;
        // The cursor is fixed at the centre of the room per DESIGN.md, and the
        // draft is centred on it rather than growing rightward from a caret —
        // which keeps the composition centred and matches where the committed
        // body will spawn.
        (uniforms["uTranslation"] as { value: number[] }).value = [0, 0];
        (uniforms["uRotation"] as { value: number }).value = 0;
        (uniforms["uScale"] as { value: number }).value = wordScale;
        (uniforms["uRoomHalfExtent"] as { value: number[] }).value = [
          roomHalfWidth,
          roomHalfHeight,
        ];
      }

      renderer.render({ scene });
    },
  };
}
