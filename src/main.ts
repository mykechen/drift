/**
 * Drift — entry point.
 *
 * Phase 0: the room renders as an empty field of paper, the frame loop runs at
 * a fixed timestep with nothing to simulate, and typing is captured but has no
 * effect. Physics, glyphs, and inference are wired in here as they land.
 */

import "./style.css";
import { attachWordInput } from "./engine/input";
import { createFrameLoop } from "./engine/loop";
import { createRoomRenderer } from "./engine/renderer";
import { debug } from "./util/debug";

const canvas = document.querySelector<HTMLCanvasElement>("canvas#room");
if (!canvas) {
  throw new Error("Drift: the #room canvas is missing from the document.");
}

const renderer = createRoomRenderer(canvas);
window.addEventListener("resize", renderer.resize);

// Phase 0 only: with no simulation to advance, a step just counts itself so the
// fixed timestep can be verified as decoupled from the display refresh rate.
// Delete once physics.step() is real.
let ticksThisSecond = 0;
let lastTickReportMs = performance.now();

const loop = createFrameLoop({
  step(): void {
    ticksThisSecond += 1;
  },
  render(): void {
    renderer.render();

    const nowMs = performance.now();
    if (nowMs - lastTickReportMs >= 1000) {
      debug("loop", `${ticksThisSecond} ticks/s`);
      ticksThisSecond = 0;
      lastTickReportMs = nowMs;
    }
  },
});

attachWordInput(window, {
  onChange(buffer): void {
    debug("input", `buffer "${buffer}"`);
  },
  onCommit(word): void {
    debug("input", `commit "${word}"`);
  },
});

loop.start();
