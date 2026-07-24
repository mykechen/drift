/**
 * The property model at runtime: a word in, six semantic scores out.
 *
 * The ONNX graph is pure arithmetic — two integer tensors in, one float tensor
 * out. Turning a word into those integers is this file's job, and the encoding
 * has to match `model/data.py` exactly: the same character ids, the same
 * padding, the same out-of-vocabulary slot. A mismatch here does not throw, it
 * silently returns the properties of some other word, which is the worst
 * possible failure mode. The constants below are mirrored from that file and
 * annotated as such.
 */

// The WebAssembly-only build, not the WebGPU one — see `loadPropertyModel`.
import * as ort from "onnxruntime-web/wasm";
// The binary is coupled to the entry point above, not chosen freely: each ORT
// build inlines one specific WebAssembly glue and will only bind against its
// matching binary. Pairing the `wasm` entry with, say, the Asyncify binary
// loads and then dies deep inside the runtime with a mangled-name TypeError
// that names neither file. If the entry point changes, this import changes
// with it.
import wasmBinaryUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import modelUrl from "./models/properties.v1.onnx?url";
import vocabUrl from "./models/properties.v1.vocab.txt?url";
import { NEUTRAL_SCORES } from "./fallback";

/** The six axes, in the order the model emits them. Mirrors `AXES` in data.py. */
export const PROPERTY_AXES = [
  "mass",
  "drag",
  "restitution",
  "warmth",
  "age",
  "intensity",
] as const;

export type PropertyAxis = (typeof PROPERTY_AXES)[number];

/** Six scores in [-1, 1]. See `model/axes.md` for what each one means. */
export type PropertyScores = Readonly<Record<PropertyAxis, number>>;

/**
 * The only execution provider the piece ships. Kept as a named type rather
 * than inlined because Phase 5's force field is a separate model that gets its
 * own measurement, and this is where a second entry would go.
 */
export type InferenceBackend = "wasm";

export interface PropertyPrediction {
  /** The normalized word the model actually scored, not what was typed. */
  readonly word: string;
  readonly scores: PropertyScores;
  /**
   * Which branch carried the prediction. `word` means the lookup table had this
   * word memorised and the score is close to its label; `char` means the score
   * was inferred from the letters alone and is a guess.
   */
  readonly branch: "word" | "char";
}

export interface PropertyModel {
  /** The execution provider the session actually started on. */
  readonly backend: InferenceBackend;
  /** Number of words in the lookup table. */
  readonly vocabularySize: number;
  /**
   * Score a word. Rejected input (per `normalizeWord`) resolves to `null`.
   * Repeat words resolve from cache without touching the session.
   */
  predict(raw: string): Promise<PropertyPrediction | null>;
  /** A cache hit if there is one, synchronously. No inference, ever. */
  peek(raw: string): PropertyPrediction | null;
  /** Release the session and its WebAssembly memory. */
  dispose(): Promise<void>;
}

// --- Encoding constants. Mirrored from model/data.py; changing one without the
// --- other silently corrupts every prediction.

/** DESIGN.md caps a committed word at 24 characters. */
const MAX_WORD_LENGTH = 24;
/** Id 0 is padding, masked out of the character mean-pool. */
const PAD_ID = 0;
/** Any character outside a-z. The corpus is a-z only; typed input is not. */
const OOV_CHAR_ID = 1;
/** 'a'. Letters run from here to FIRST_LETTER_ID + 25. */
const FIRST_LETTER_ID = 2;
/** Lookup id 0 is the shared unknown slot — every word not in the table. */
const WORD_UNK_ID = 0;

const CHAR_CODE_A = "a".charCodeAt(0);
const CHAR_CODE_Z = "z".charCodeAt(0);

/** Per ROADMAP: cap the cache at ~5000 entries. */
const CACHE_CAPACITY = 5000;

/**
 * Strip trailing punctuation and lowercase; return null if the word is not
 * scoreable.
 *
 * Per DESIGN.md the glyph keeps its punctuation — `hello,` renders with the
 * comma and the comma is part of the physics body — but the model is asked
 * about `hello`. Refusals are exactly the three CLAUDE.md allows: a digit
 * anywhere, nothing left after stripping, or longer than the character branch
 * can encode.
 */
export function normalizeWord(raw: string): string | null {
  const lowered = raw.toLowerCase();
  if (lowered.length > MAX_WORD_LENGTH) return null;
  // A digit anywhere disqualifies the word — this is a piece about language.
  if (/\d/.test(lowered)) return null;

  const stripped = lowered.replace(/[^a-z]+$/u, "");
  // Nothing left means standalone punctuation, which does not commit.
  if (stripped.length === 0) return null;

  return stripped;
}

/** Map a word to fixed-length character ids, right-padded. Mirrors `encode_chars`. */
function encodeChars(word: string, into: Int32Array): void {
  into.fill(PAD_ID);
  const length = Math.min(word.length, MAX_WORD_LENGTH);
  for (let index = 0; index < length; index += 1) {
    const code = word.charCodeAt(index);
    into[index] =
      code >= CHAR_CODE_A && code <= CHAR_CODE_Z
        ? FIRST_LETTER_ID + (code - CHAR_CODE_A)
        : OOV_CHAR_ID;
  }
}

function toScores(raw: Float32Array, offset = 0): PropertyScores {
  const scores: Record<string, number> = {};
  for (let axis = 0; axis < PROPERTY_AXES.length; axis += 1) {
    // Non-null: PROPERTY_AXES is a fixed tuple and the loop bound is its length.
    scores[PROPERTY_AXES[axis]!] = raw[offset + axis] ?? 0;
  }
  return Object.freeze(scores as Record<PropertyAxis, number>);
}

/**
 * Load the vocabulary word list into a lookup map.
 *
 * The file is one word per line, and a word's id is its line number counting
 * from 1 — id 0 is reserved for the unknown slot. That positional encoding is
 * asserted at export time in `export_onnx.py`.
 */
async function loadVocabulary(): Promise<Map<string, number>> {
  const response = await fetch(vocabUrl);
  if (!response.ok) {
    throw new Error(
      `Drift: vocabulary fetch failed with ${String(response.status)}.`,
    );
  }
  const words = (await response.text()).split("\n");
  const table = new Map<string, number>();
  for (let index = 0; index < words.length; index += 1) {
    // Non-null: index is bounded by words.length.
    table.set(words[index]!, index + 1);
  }
  return table;
}

/**
 * Load the model and return a handle that scores words.
 *
 * **Why WebAssembly and not WebGPU.** CLAUDE.md originally specified WebGPU
 * with a WebAssembly fallback. Measured on an Apple Metal-3 adapter over 40
 * distinct vocabulary words, WebGPU is worse on every axis that matters here:
 *
 * | | first run | p50 | p95 | download (brotli) |
 * |---|---|---|---|---|
 * | wasm   | 1.0ms  | 0.10ms | 0.20ms | 2.05MB |
 * | webgpu | 326ms cold, 17.6ms warm | 1.50ms | 2.30ms | 3.28MB |
 *
 * Two independent reasons, both structural rather than tunable. A model with
 * 570k parameters and a batch of one has nothing to parallelise, so per-dispatch
 * overhead is the entire cost — the GPU is pure latency here. And ONNX Runtime's
 * WebGPU build requires the 23MB Asyncify binary where the plain build needs
 * 13MB, so the slower option is also the heavier one. The 326ms cold first run
 * is the sharpest edge: it lands on the first word of a fresh session.
 *
 * Phase 5's force field is a different model with a different shape and gets
 * measured on its own terms rather than inheriting this conclusion.
 *
 * Throws if the runtime cannot start at all — callers that must not fail should
 * catch and fall back to `NEUTRAL_SCORES`.
 */
export async function loadPropertyModel(): Promise<PropertyModel> {
  // Single-threaded on purpose. Multi-threaded WebAssembly needs SharedArrayBuffer,
  // which needs COOP/COEP headers, which would make the page cross-origin
  // isolated for the sake of parallelising a model with 570k parameters. There
  // is nothing here to parallelise.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: wasmBinaryUrl };

  const [modelResponse, vocabulary] = await Promise.all([
    fetch(modelUrl),
    loadVocabulary(),
  ]);
  if (!modelResponse.ok) {
    throw new Error(
      `Drift: model fetch failed with ${String(modelResponse.status)}.`,
    );
  }
  const modelBytes = await modelResponse.arrayBuffer();

  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  // Reused across every call. A single-word inference allocates nothing beyond
  // the output tensor, which matters when this runs on every keystroke.
  const charBuffer = new Int32Array(MAX_WORD_LENGTH);
  const wordIdBuffer = new Int32Array(1);
  const charTensor = new ort.Tensor("int32", charBuffer, [1, MAX_WORD_LENGTH]);
  const wordIdTensor = new ort.Tensor("int32", wordIdBuffer, [1]);
  const feeds = { chars: charTensor, word_id: wordIdTensor };

  // The first run through a fresh session costs ~25ms of one-time kernel setup;
  // every run after it is ~0.1ms. Spending it here, while the room is still
  // loading, means the first word someone actually types is not the one that
  // pays. The result is thrown away — the buffers are zeroed, so this scores
  // the empty string.
  await session.run(feeds);

  // Insertion-ordered Map as an LRU: re-inserting on a hit moves the entry to
  // the end, so the oldest key is always the first one iteration yields.
  const cache = new Map<string, PropertyPrediction>();

  function remember(word: string, prediction: PropertyPrediction): void {
    cache.set(word, prediction);
    if (cache.size > CACHE_CAPACITY) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }

  function recall(word: string): PropertyPrediction | null {
    const hit = cache.get(word);
    if (hit === undefined) return null;
    cache.delete(word);
    cache.set(word, hit);
    return hit;
  }

  return {
    backend: "wasm",
    vocabularySize: vocabulary.size,

    peek(raw: string): PropertyPrediction | null {
      const word = normalizeWord(raw);
      return word === null ? null : recall(word);
    },

    async predict(raw: string): Promise<PropertyPrediction | null> {
      const word = normalizeWord(raw);
      if (word === null) return null;

      const cached = recall(word);
      if (cached !== null) return cached;

      const wordId = vocabulary.get(word) ?? WORD_UNK_ID;
      encodeChars(word, charBuffer);
      wordIdBuffer[0] = wordId;

      const output = await session.run(feeds);
      const scores = output["scores"];
      if (scores === undefined || !(scores.data instanceof Float32Array)) {
        throw new Error("Drift: the model returned no float `scores` output.");
      }

      const prediction: PropertyPrediction = Object.freeze({
        word,
        scores: toScores(scores.data),
        branch: wordId === WORD_UNK_ID ? ("char" as const) : ("word" as const),
      });
      remember(word, prediction);
      return prediction;
    },

    async dispose(): Promise<void> {
      cache.clear();
      await session.release();
    },
  };
}

export { NEUTRAL_SCORES };
