/**
 * Multiline input + bracketed-paste handling (#160). The terminal wraps pasted
 * text in bracketed-paste markers (ESC[200~ … ESC[201~); a paste — or any input
 * containing newlines — should be inserted into the buffer instead of submitting
 * line-by-line. A line ending in a single backslash also continues to the next
 * line. The parsing here is pure and tested; the InputBar wires it to keystrokes.
 */

// Bracketed-paste markers, with or without the leading ESC (terminals send
// \x1b[200~ … \x1b[201~; some layers strip the ESC before we see them).
// eslint-disable-next-line no-control-regex
const PASTE_MARKERS = /\x1b?\[20[01]~/g;

export interface ParsedInput {
  text: string;
  /** True if this input was a paste or otherwise spans multiple lines. */
  isMultiline: boolean;
}

/** Strip bracketed-paste markers and detect multi-line input. */
export function parseBracketedPaste(input: string): ParsedInput {
  const text = input.replace(PASTE_MARKERS, "");
  if (text !== input) return { text, isMultiline: true }; // markers were present → a paste
  return { text, isMultiline: input.includes("\n") };
}

/** True when a buffer ends with a single (unescaped) backslash — a line continuation. */
export function endsWithContinuation(value: string): boolean {
  const match = value.match(/(\\+)$/);
  if (!match) return false;
  return match[1].length % 2 === 1; // odd number of trailing backslashes = continuation
}

/** Replace the trailing continuation backslash with a newline. */
export function applyContinuation(value: string): string {
  return value.replace(/\\$/, "\n");
}

/** Insert `pasted` into `value` at `cursor`, returning the new value. */
export function insertPaste(value: string, cursor: number, pasted: string): string {
  const pos = Math.max(0, Math.min(cursor, value.length));
  return value.slice(0, pos) + pasted + value.slice(pos);
}

/** Render a (possibly multiline) buffer for the single-line input box: show the
 *  last line, prefixed with a "lines so far" hint when there's more above. */
export function previewBuffer(value: string): string {
  if (!value.includes("\n")) return value;
  const lines = value.split("\n");
  const last = lines[lines.length - 1];
  return `…(+${lines.length - 1} line${lines.length - 1 === 1 ? "" : "s"}) ${last}`;
}
