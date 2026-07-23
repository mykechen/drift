import { Color, Renderer, Transform } from "ogl";
import { BACKGROUND } from "../design/palette";
import { debug } from "../util/debug";

/** Retina is worth paying for; 3× displays are not. */
const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * Members are typed as function properties rather than methods because they are
 * closures with no `this` — they stay correct when passed as bare event
 * listeners.
 */
export interface RoomRenderer {
  /** Root of the scene graph. Word bodies are attached here from Phase 2. */
  readonly scene: Transform;
  /** Re-reads the canvas's CSS size and resizes the drawing buffer to match. */
  readonly resize: () => void;
  readonly render: () => void;
}

/**
 * Creates the WebGL renderer for the room. Phase 0 draws nothing but the
 * background — the scene graph is empty until words become bodies.
 */
export function createRoomRenderer(canvas: HTMLCanvasElement): RoomRenderer {
  const renderer = new Renderer({
    canvas,
    dpr: Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO),
    // The room is opaque paper, and 2D — no alpha or depth buffer needed.
    alpha: false,
    depth: false,
    antialias: true,
  });

  const background = new Color(BACKGROUND);
  renderer.gl.clearColor(background.r, background.g, background.b, 1);

  const scene = new Transform();

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

  function render(): void {
    renderer.render({ scene });
  }

  resize();

  return { scene, resize, render };
}
