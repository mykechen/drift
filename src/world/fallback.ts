/**
 * The mobile fallback, and the check that runs before anything else loads.
 *
 * This module is deliberately tiny and deliberately dependency-free. It is the
 * only thing besides the stylesheet that a phone downloads, and the whole point
 * of the check is that it happens *before* the physics runtime, the glyph
 * pipeline, the ONNX runtime and the model are even requested. Import anything
 * heavy from here and the saving disappears — the bundler will pull it into the
 * entry chunk and the phone will fetch it to be told to go away.
 */

/**
 * Per DESIGN.md: viewport width under 768px, or touch-only.
 *
 * "Touch-only" is `any-pointer: coarse` with no `any-pointer: fine` anywhere on
 * the device, which is the distinction that matters here. A touchscreen laptop
 * reports both and gets the piece, because it has the keyboard the piece needs;
 * a tablet reports only coarse and gets the fallback, because it does not.
 *
 * Evaluated once, at load. It is deliberately not re-evaluated on resize: a
 * desktop window dragged narrower should not tear down a room full of words,
 * and a phone cannot become a desktop mid-session.
 */
export function isMobileVisitor(): boolean {
  const MOBILE_MAX_VIEWPORT_PX = 768;
  if (window.innerWidth < MOBILE_MAX_VIEWPORT_PX) return true;
  return (
    window.matchMedia("(any-pointer: coarse)").matches &&
    !window.matchMedia("(any-pointer: fine)").matches
  );
}

/**
 * Replace the canvas with the still and its one line of text.
 *
 * Per DESIGN.md the mobile page *is* the piece for that visitor: no back
 * button, no dismiss, no way to force the real thing. The canvas is removed
 * rather than hidden so no WebGL context is ever created.
 */
export function showMobileFallback(canvas: HTMLCanvasElement): void {
  const figure = document.createElement("figure");
  figure.className = "fallback";

  const image = document.createElement("img");
  // Not fingerprinted into /assets on purpose. This still is regenerated
  // whenever the room's design changes — it is a picture of the piece, not a
  // build artifact — so it wants a revalidating cache rather than an immutable
  // one, which is exactly what an un-hashed file in /public gets.
  image.src = "/mobile-fallback.webp";
  image.alt =
    "A composition of typed words settled into a pile at the bottom of a warm off-white room.";
  // Declared so the layout does not shift when the image arrives, and so the
  // browser can size it before decoding. Captured from the room at 4:3 — the
  // narrowest frame DESIGN.md allows, and the one where a phone can still read
  // the words — then cropped down to the composition, because the room's empty
  // air reads as a blank image at 390px wide.
  image.width = 1024;
  image.height = 468;
  image.decoding = "async";

  const caption = document.createElement("figcaption");
  caption.textContent = "Drift is made for a keyboard. Come back on a desktop.";

  figure.append(image, caption);
  canvas.replaceWith(figure);
}
