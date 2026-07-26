/**
 * Drift — entry point, and the one decision made before anything loads.
 *
 * There is exactly one branch in this file and it is the reason the file
 * exists. A phone that is going to be shown a still image and a line of text
 * must not first download the physics runtime, the glyph pipeline, the ONNX
 * runtime and the model — which is what a static import of the room would
 * cost it, and did cost it until Phase 2.5. The room hangs off a dynamic
 * import so the bundler puts it in a chunk that is only ever requested on the
 * branch that uses it.
 *
 * Keep this file's static imports trivial. Anything imported here is
 * downloaded by every visitor on every device, before the branch is taken.
 */

import "./style.css";
import { isMobileVisitor, showMobileFallback } from "./world/fallback";

const canvas = document.querySelector<HTMLCanvasElement>("canvas#room");
if (!canvas) {
  throw new Error("Drift: the #room canvas is missing from the document.");
}

if (isMobileVisitor()) {
  showMobileFallback(canvas);
} else {
  const { startRoom } = await import("./boot");
  await startRoom(canvas);
}
