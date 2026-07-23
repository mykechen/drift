/**
 * Keyboard capture and the in-progress word buffer.
 *
 * Listens on the window rather than an `<input>` element — the piece has no
 * form controls and the caret is drawn, not native.
 *
 * Phase 0 captures typing and nothing more. The commit rules that produce
 * visible feedback — digits rejected, 24-character cap, standalone punctuation
 * refused — land in Phase 2 alongside the shake that communicates them.
 */

import { debug } from "../util/debug";

export interface WordInputCallbacks {
  /** Fires whenever the in-progress buffer changes, including when cleared. */
  onChange(buffer: string): void;
  /** Fires when space or enter commits a non-empty buffer. */
  onCommit(word: string): void;
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
    if (buffer.length === 0) return;
    buffer = buffer.slice(0, -1);
    callbacks.onChange(buffer);
  }

  function append(character: string): void {
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
