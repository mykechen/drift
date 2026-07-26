/**
 * /debug/glyphs — see the collision geometry the physics engine will actually get.
 *
 * Internal, unlinked, noindexed. ROADMAP asks for the convex decomposition to
 * be verified by hand on the glyphs that break naive implementations, and the
 * only way to verify a hull is to look at it. Outlines draw as lines, hulls
 * draw as filled translucent polygons — where the two disagree is the bug.
 *
 * The counters of `o` `e` `a` `b` `d` `g` `p` `q` must stay empty; the tittle
 * of `i` must stay attached and separate.
 */

import "./glyphs.css";
import {
  loadGlyphSource,
  type GlyphSource,
  type WordGeometry,
} from "../engine/glyphs";
import { NEUTRAL_AXES, type FontAxes } from "../design/typography";

/** Glyphs whose decomposition is load-bearing, per DESIGN.md's sixth behaviour. */
const FAILURE_CASES = ["o", "e", "a", "b", "d", "g", "p", "q", "i", "s"];

const HULL_COLORS = [
  "#D94F1E",
  "#1A6B8C",
  "#7A9A3B",
  "#8C4A9E",
  "#C4901E",
  "#3B7A6B",
  "#A8425C",
  "#4A5FA8",
];

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Drift debug: ${selector} is missing.`);
  return element;
}

const statusEl = required<HTMLParagraphElement>("#status");
const wordEl = required<HTMLInputElement>("#word");
const wghtEl = required<HTMLInputElement>("#wght");
const wdthEl = required<HTMLInputElement>("#wdth");
const wghtValueEl = required<HTMLOutputElement>("#wght-value");
const wdthValueEl = required<HTMLOutputElement>("#wdth-value");
const tolEl = required<HTMLInputElement>("#tol");
const tolValueEl = required<HTMLOutputElement>("#tol-value");
const stageEl = required<HTMLCanvasElement>("#stage");
const statsEl = required<HTMLParagraphElement>("#stats");
const gridEl = required<HTMLDivElement>("#grid");
const budgetEl = required<HTMLPreElement>("#budget-output");

/** The slider carries the exponent; the tolerance is 1/2^n em. */
function currentTolerance(): number {
  return 1 / 2 ** Number(tolEl.value);
}

/**
 * Draw geometry into a context, fitted to the box with a margin.
 *
 * Em units are y-up (the font's own convention) and canvas is y-down, so the
 * vertical axis is flipped here rather than in the pipeline — physics wants
 * y-up too, and only drawing disagrees.
 */
function draw(
  context: CanvasRenderingContext2D,
  geometry: WordGeometry,
  boxWidth: number,
  boxHeight: number,
  margin: number,
): void {
  context.clearRect(0, 0, boxWidth, boxHeight);
  if (geometry.contours.length === 0) return;

  const scale = Math.min(
    (boxWidth - margin * 2) / Math.max(geometry.width, 1e-6),
    (boxHeight - margin * 2) / Math.max(geometry.height, 1e-6),
  );
  const toX = (x: number): number => boxWidth / 2 + x * scale;
  const toY = (y: number): number => boxHeight / 2 - y * scale;

  geometry.hulls.forEach((hull, index) => {
    context.beginPath();
    context.moveTo(toX(hull[0]!), toY(hull[1]!));
    for (let i = 2; i < hull.length; i += 2) {
      context.lineTo(toX(hull[i]!), toY(hull[i + 1]!));
    }
    context.closePath();
    context.fillStyle = HULL_COLORS[index % HULL_COLORS.length]!;
    context.globalAlpha = 0.28;
    context.fill();
    context.globalAlpha = 0.9;
    context.lineWidth = 1;
    context.strokeStyle = HULL_COLORS[index % HULL_COLORS.length]!;
    context.stroke();
  });

  context.globalAlpha = 1;
  context.strokeStyle = "#1A1817";
  context.lineWidth = 1.5;
  for (const contour of geometry.contours) {
    context.beginPath();
    context.moveTo(toX(contour[0]!), toY(contour[1]!));
    for (let i = 2; i < contour.length; i += 2) {
      context.lineTo(toX(contour[i]!), toY(contour[i + 1]!));
    }
    context.closePath();
    context.stroke();
  }
}

let source: GlyphSource | null = null;

function currentAxes(): FontAxes {
  return { wght: Number(wghtEl.value), wdth: Number(wdthEl.value) };
}

/** A spread of real words, so the budget is not measured on one lucky string. */
const BUDGET_WORDS = [
  "boulder",
  "feather",
  "silence",
  "ember",
  "ocean",
  "a",
  "the",
  "extraordinary",
];

/**
 * Sweep the tolerance and report hulls per word at each setting.
 *
 * The number that matters is the last column: hulls per word times the 200-body
 * soft cap from DESIGN.md is the collider count the physics step has to carry
 * at full density.
 */
function measureBudget(): void {
  if (!source) return;
  const axes = currentAxes();
  const rows = ["tolerance    tris/word   hulls/word   at 200 bodies   build"];
  for (let exponent = 3; exponent <= 7; exponent += 1) {
    const tolerance = 1 / 2 ** exponent;
    const startedAt = performance.now();
    let hulls = 0;
    let triangles = 0;
    for (const word of BUDGET_WORDS) {
      const geometry = source.geometryFor(word, axes, tolerance);
      hulls += geometry.hulls.length;
      triangles += geometry.triangleCount;
    }
    const elapsedMs = performance.now() - startedAt;
    const perWord = hulls / BUDGET_WORDS.length;
    rows.push(
      `1/${String(2 ** exponent)} em`.padEnd(13) +
        (triangles / BUDGET_WORDS.length).toFixed(1).padStart(9) +
        perWord.toFixed(1).padStart(13) +
        Math.round(perWord * 200)
          .toLocaleString("en-US")
          .padStart(16) +
        `${(elapsedMs / BUDGET_WORDS.length).toFixed(2)}ms`.padStart(9),
    );
  }
  budgetEl.textContent = rows.join("\n");
}

function renderWord(): void {
  if (!source) return;
  const context = stageEl.getContext("2d");
  if (!context) return;

  const axes = currentAxes();
  const word = wordEl.value.trim() || " ";

  const startedAt = performance.now();
  const geometry = source.geometryFor(word, axes, currentTolerance());
  const elapsedMs = performance.now() - startedAt;

  draw(context, geometry, stageEl.width, stageEl.height, 48);

  const points = geometry.hulls.reduce(
    (total, hull) => total + hull.length / 2,
    0,
  );
  statsEl.textContent =
    `${String(geometry.contours.length)} contours · ` +
    `${String(geometry.triangleCount)} triangles → ` +
    `${String(geometry.hulls.length)} convex hulls · ` +
    `${String(points)} hull points · ` +
    `${geometry.width.toFixed(2)}×${geometry.height.toFixed(2)} em · ` +
    `built in ${elapsedMs.toFixed(2)}ms`;
}

function renderCases(): void {
  if (!source) return;
  const axes = currentAxes();
  gridEl.replaceChildren();

  for (const character of FAILURE_CASES) {
    const geometry = source.geometryFor(character, axes, currentTolerance());

    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const context = canvas.getContext("2d");
    if (context) draw(context, geometry, canvas.width, canvas.height, 24);

    const caption = document.createElement("figcaption");
    caption.textContent = `${character} · ${String(geometry.contours.length)}c · ${String(geometry.hulls.length)}h`;

    const figure = document.createElement("figure");
    figure.append(canvas, caption);
    gridEl.append(figure);
  }
}

function renderAll(): void {
  wghtValueEl.textContent = wghtEl.value;
  wdthValueEl.textContent = wdthEl.value;
  tolValueEl.textContent = `1/${String(2 ** Number(tolEl.value))} em`;
  renderWord();
  renderCases();
  measureBudget();
}

wordEl.addEventListener("input", renderWord);
wghtEl.addEventListener("input", renderAll);
wdthEl.addEventListener("input", renderAll);
tolEl.addEventListener("input", renderAll);

const startedAt = performance.now();
loadGlyphSource()
  .then((loaded) => {
    source = loaded;
    const loadMs = performance.now() - startedAt;
    statusEl.textContent = `Archivo · wght ${String(NEUTRAL_AXES.wght)} wdth ${String(NEUTRAL_AXES.wdth)} neutral · decoded in ${loadMs.toFixed(0)}ms`;
    wordEl.disabled = false;
    renderAll();
    wordEl.focus();
  })
  .catch((error: unknown) => {
    statusEl.textContent = `font failed to load — ${String(error)}`;
  });
