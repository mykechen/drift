/**
 * Keyboard capture and the in-progress word buffer.
 *
 * Listens on the window rather than an `<input>` element — the piece has no
 * form controls and the caret is drawn, not native.
 *
 * The commit rules that produce visible feedback — digits rejected,
 * 24-character cap, standalone punctuation refused — landed in Phase 3, with
 * the shake that communicates them. The rules themselves live in
 * `normalizeWord`; what is here is the length cap, which has to act on the
 * keystroke rather than at commit so that the 25th character never appears.
 */

import { debug } from "../util/debug";
import { MAX_WORD_LENGTH } from "../ml/properties";

export interface WordInputCallbacks {
  /** Fires whenever the in-progress buffer changes, including when cleared. */
  onChange(buffer: string): void;
  /** Fires when space or enter commits a non-empty buffer. */
  onCommit(word: string): void;
  /**
   * Fires when the piece refuses an keystroke or a commit: past the length cap,
   * or backspace on an empty buffer. DESIGN.md answers all of these with the
   * same subtle shake, so they are one callback rather than three.
   */
  onRejected(): void;
}

export interface WordInput {
  readonly detach: () => void;
}

/**
 * Binds typing to a word buffer. Returns a handle that unbinds the listeners.
 */
export function attachWordInput(
  target: Window,
  callbacks: WordInputCallbacks,
): WordInput {
  let buffer = "";

  function commit(): void {
    // Space on an empty buffer is a no-op: no sound, no feedback, silence.
    // This is also what absorbs runs of consecutive spaces.
    if (buffer.length === 0) return;

    const word = buffer;
    buffer = "";
    callbacks.onChange(buffer);
    callbacks.onCommit(word);
  }

  function backspace(): void {
    // DESIGN.md: "If the word is empty, backspace is a no-op (small subtle
    // shake to indicate)."
    if (buffer.length === 0) {
      callbacks.onRejected();
      return;
    }
    buffer = buffer.slice(0, -1);
    callbacks.onChange(buffer);
  }

  function append(character: string): void {
    // The cap acts on the keystroke, not on the commit. Accepting a 25th
    // character and refusing the whole word later would let the visitor watch
    // something form that was never going to be allowed.
    if (buffer.length >= MAX_WORD_LENGTH) {
      callbacks.onRejected();
      return;
    }
    buffer += character;
    callbacks.onChange(buffer);
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Cmd/Ctrl combinations belong to the shortcuts claimed in later phases
    // (save image, copy replay URL, clear). Let them through untouched.
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === " " || event.key === "Enter") {
      // Space would otherwise scroll the document.
      event.preventDefault();
      commit();
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      backspace();
      return;
    }

    // Single-character keys are the printable ones; "Shift", "ArrowLeft" and
    // friends are all longer than one character.
    if (event.key.length === 1) {
      append(event.key);
    }
  }

  function onPaste(event: ClipboardEvent): void {
    // The piece is about the pace of typing, not dumping text.
    event.preventDefault();
    debug("input", "paste blocked");
  }

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("paste", onPaste);

  return {
    detach(): void {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("paste", onPaste);
    },
  };
}
