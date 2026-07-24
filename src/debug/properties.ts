/**
 * /debug/properties — type a word, see what the shipping model thinks it is.
 *
 * Internal, unlinked, noindexed. It exists to answer three questions that
 * cannot be answered from Python: does the quantized model still feel right in
 * a browser, which backend actually starts, and does a prediction land inside
 * the 5ms budget on real hardware. Everything on the page is in service of one
 * of those three.
 *
 * It runs inference on every keystroke rather than on commit. That is heavier
 * than the piece will ever be, which is the point — if the budget holds here it
 * holds in the room.
 */

import "./properties.css";
import {
  PROPERTY_AXES,
  loadPropertyModel,
  normalizeWord,
  type PropertyAxis,
  type PropertyModel,
} from "../ml/properties";
import vocabUrl from "../ml/models/properties.v1.vocab.txt?url";

/** ROADMAP's budget: a prediction must complete in under this on a mid-range laptop. */
const LATENCY_BUDGET_MS = 5;
const BENCHMARK_SAMPLE_SIZE = 300;

/**
 * The loaded model, and the words the benchmark draws from, hung on `window`.
 *
 * Only this page does it, and only because the interesting questions here get
 * asked from a console or an automation driver — "score these forty words and
 * give me the spread" is not worth a button, but it is worth being able to type.
 * The piece itself exposes nothing.
 */
declare global {
  interface Window {
    drift?: { model: PropertyModel | null; sample: readonly string[] };
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element)
    throw new Error(`Drift debug: ${selector} is missing from the document.`);
  return element;
}

const statusEl = required<HTMLParagraphElement>("#status");
const wordEl = required<HTMLInputElement>("#word");
const verdictEl = required<HTMLParagraphElement>("#verdict");
const axesEl = required<HTMLDListElement>("#axes");
const runBenchEl = required<HTMLButtonElement>("#run-bench");
const benchOutputEl = required<HTMLPreElement>("#bench-output");

/** One row per axis, built once; only the fill width and the value text change. */
const rows = new Map<
  PropertyAxis,
  { fill: HTMLDivElement; value: HTMLElement }
>();

for (const axis of PROPERTY_AXES) {
  const term = document.createElement("dt");
  term.textContent = axis;

  const track = document.createElement("div");
  track.className = "track";
  const fill = document.createElement("div");
  fill.className = "fill";
  track.append(fill);

  const trackCell = document.createElement("dd");
  trackCell.append(track);

  const value = document.createElement("dd");
  value.className = "value";
  value.textContent = "—";

  axesEl.append(term, trackCell, value);
  rows.set(axis, { fill, value });
}

/** Draw a score in [-1, 1] as a fill running from the centre line outward. */
function drawScore(axis: PropertyAxis, score: number | null): void {
  const row = rows.get(axis);
  if (!row) return;

  if (score === null) {
    row.fill.style.width = "0%";
    row.value.textContent = "—";
    return;
  }

  const clamped = Math.max(-1, Math.min(1, score));
  const halfWidthPercent = (Math.abs(clamped) / 2) * 100;
  row.fill.style.width = `${String(halfWidthPercent)}%`;
  if (clamped >= 0) {
    row.fill.style.left = "50%";
    row.fill.style.right = "auto";
  } else {
    row.fill.style.right = "50%";
    row.fill.style.left = "auto";
  }
  row.value.textContent = clamped.toFixed(3);
}

function clearScores(): void {
  for (const axis of PROPERTY_AXES) drawScore(axis, null);
}

let model: PropertyModel | null = null;
/** Guards against an out-of-order resolve overwriting a newer keystroke's scores. */
let latestRequestId = 0;

async function score(raw: string): Promise<void> {
  const requestId = (latestRequestId += 1);

  if (raw.trim().length === 0) {
    verdictEl.textContent = "";
    verdictEl.removeAttribute("data-branch");
    clearScores();
    return;
  }

  const normalized = normalizeWord(raw);
  if (normalized === null) {
    verdictEl.textContent = "rejected — a digit, empty, or over 24 characters";
    verdictEl.removeAttribute("data-branch");
    clearScores();
    return;
  }

  if (!model) return;

  const wasCached = model.peek(raw) !== null;
  const startedAt = performance.now();
  const prediction = await model.predict(raw);
  const elapsedMs = performance.now() - startedAt;

  // A slower earlier keystroke must not repaint over a faster later one.
  if (requestId !== latestRequestId || !prediction) return;

  for (const axis of PROPERTY_AXES) drawScore(axis, prediction.scores[axis]);

  const source =
    prediction.branch === "word" ? "in vocabulary" : "character branch";
  const budget = elapsedMs <= LATENCY_BUDGET_MS ? "" : "  over budget";
  verdictEl.dataset["branch"] = prediction.branch;
  verdictEl.textContent =
    `"${prediction.word}" · ${source} · ` +
    `${elapsedMs.toFixed(2)}ms${wasCached ? " (cached)" : ""}${budget}`;
}

wordEl.addEventListener("input", () => {
  void score(wordEl.value);
});

/** p-th percentile of an already-sorted array, nearest-rank. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? NaN;
}

/**
 * Time cold predictions on distinct vocabulary words.
 *
 * Distinct on purpose: every sampled word is a genuine cache miss, so this
 * measures the session, not the Map in front of it. Sampling from the
 * vocabulary rather than from nonsense keeps the word branch in play, which is
 * where the 2.3MB embedding table gets indexed.
 */
async function benchmark(
  active: PropertyModel,
  sample: readonly string[],
): Promise<string> {
  // The first run after session creation pays for kernel setup and is reported
  // separately rather than being allowed to poison the percentiles.
  const firstStartedAt = performance.now();
  await active.predict(sample[0] ?? "boulder");
  const firstRunMs = performance.now() - firstStartedAt;

  const timings: number[] = [];
  for (const word of sample.slice(1)) {
    const startedAt = performance.now();
    await active.predict(word);
    timings.push(performance.now() - startedAt);
  }
  timings.sort((a, b) => a - b);

  const cachedStartedAt = performance.now();
  for (const word of sample.slice(1)) active.peek(word);
  const cachedMeanMs =
    (performance.now() - cachedStartedAt) / Math.max(1, sample.length - 1);

  const verdict =
    percentile(timings, 95) <= LATENCY_BUDGET_MS ? "PASS" : "FAIL";
  return [
    `backend         ${active.backend}`,
    `samples         ${String(timings.length)} distinct vocabulary words, all cache misses`,
    `first run       ${firstRunMs.toFixed(2)}ms  (includes kernel setup)`,
    `p50             ${percentile(timings, 50).toFixed(2)}ms`,
    `p95             ${percentile(timings, 95).toFixed(2)}ms`,
    `max             ${(timings[timings.length - 1] ?? NaN).toFixed(2)}ms`,
    `cached lookup   ${cachedMeanMs.toFixed(4)}ms  (mean, no inference)`,
    `budget          ${String(LATENCY_BUDGET_MS)}ms — ${verdict} on p95`,
  ].join("\n");
}

let vocabularySample: string[] = [];

/** Pull distinct random words from the shipped vocabulary for the benchmark. */
async function loadVocabularySample(): Promise<string[]> {
  const words = (await (await fetch(vocabUrl)).text()).split("\n");
  const picked = new Set<string>();
  // Deterministic stride rather than a random walk: the same words every run,
  // so two backends are compared on identical input.
  const stride = Math.max(1, Math.floor(words.length / BENCHMARK_SAMPLE_SIZE));
  for (
    let index = 0;
    picked.size < BENCHMARK_SAMPLE_SIZE && index < words.length;
    index += stride
  ) {
    const word = words[index];
    if (word !== undefined && word.length > 0) picked.add(word);
  }
  return [...picked];
}

runBenchEl.addEventListener("click", () => {
  if (!model) return;
  const active = model;
  runBenchEl.disabled = true;
  benchOutputEl.textContent = "running…";
  void benchmark(active, vocabularySample)
    .then((report) => {
      benchOutputEl.textContent = report;
    })
    .catch((error: unknown) => {
      benchOutputEl.textContent = `benchmark failed: ${String(error)}`;
    })
    .finally(() => {
      runBenchEl.disabled = false;
    });
});

async function activate(): Promise<void> {
  statusEl.textContent = "starting…";

  const startedAt = performance.now();
  try {
    model = await loadPropertyModel();
  } catch (error) {
    statusEl.textContent = `model failed to load — ${String(error)}`;
    return;
  }
  const loadMs = performance.now() - startedAt;

  statusEl.textContent =
    `properties.v1.onnx · ${model.backend} · ` +
    `${String(model.vocabularySize)} words in vocabulary · ` +
    `ready in ${loadMs.toFixed(0)}ms`;

  window.drift = { model, sample: vocabularySample };

  wordEl.disabled = false;
  runBenchEl.disabled = false;
  wordEl.focus();
  void score(wordEl.value);
}

void loadVocabularySample().then((sample) => {
  vocabularySample = sample;
  if (window.drift) window.drift.sample = sample;
});
void activate();
