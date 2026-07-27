/**
 * The lexicon: what counts as a word.
 *
 * Phase 3 split a job the property model's character branch was doing badly on
 * its own. The branch is good at real words the model has not seen —
 * `gloaming`, `spindrift`, `tarn` — and bad at strings with no meaning to read,
 * because a word's physical feel is semantic rather than orthographic. Measured
 * in Phase 1c, `asdf` scored warmth +0.66: the model inventing a feeling for a
 * string that has none. A room where `asdfgh` lands with a mass is a room that
 * contradicts its own premise.
 *
 * So this answers "is this a word?" and the character branch answers "what does
 * it feel like?". They are complements, not substitutes: the model knows 10,749
 * words and this list allows ~78,000, so the branch still scores roughly 67,000
 * words the model has never seen. It has a clearer job now, not a smaller one.
 *
 * How the list is built — a real dictionary intersected with a frequency list,
 * and why neither works alone — is in `model/build_lexicon.py`.
 *
 * This supersedes `DESIGN.md`'s "nonsense strings should get plausible-feeling
 * properties ... this is a feature" and `CLAUDE.md`'s "never refuse a commit
 * because the model hasn't seen the word". Both documents were amended rather
 * than quietly contradicted; the second is still true as written, since the
 * refusal is not about what the *model* has seen.
 */

import lexiconUrl from "./lexicon.v1.txt?url";
import { debug } from "../util/debug";

export interface Lexicon {
  /** Whether a string is a word the room will accept. Expects lowercase. */
  readonly has: (word: string) => boolean;
  /** How many words are allowed. Diagnostic. */
  readonly size: number;
}

/**
 * A `Set` of ~78,000 short strings rather than anything cleverer.
 *
 * A trie or a Bloom filter would use less memory, and neither is worth it: the
 * set costs a few megabytes on a page that already holds a WASM physics engine
 * and an ONNX runtime, and `Set.has` is the fastest lookup available with no
 * false positives to reason about. A Bloom filter's false-positive rate would
 * mean occasionally admitting a mash string, which is the one thing this exists
 * to prevent.
 */
export async function loadLexicon(): Promise<Lexicon> {
  const response = await fetch(lexiconUrl);
  if (!response.ok) {
    throw new Error(
      `Drift: lexicon fetch failed with ${String(response.status)}.`,
    );
  }

  const words = new Set<string>();
  for (const line of (await response.text()).split("\n")) {
    const word = line.trim();
    if (word.length > 0) words.add(word);
  }

  debug("ml", `lexicon ready · ${String(words.size)} words`);

  return {
    has: (word: string): boolean => words.has(word),
    size: words.size,
  };
}
