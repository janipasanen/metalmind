/**
 * Terminal-output sanitization (#373).
 *
 * Tool output (test runners, linters, build logs) and file content are full of
 * ANSI escape sequences, carriage returns and other control bytes. Rendering
 * them raw inside an Ink <Text> corrupts the frame: an unterminated colour code
 * bleeds into the rest of the TUI, a CR jumps the cursor to column 0 and paints
 * over panel borders, and a naive `.slice(0, n)` can cut an escape sequence in
 * half so the terminal swallows whatever text follows.
 *
 * Everything shown in a panel goes through `sanitizeForDisplay` first.
 */

/** CSI sequences (colour, cursor movement): ESC [ … final-byte. */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** OSC sequences (window title, hyperlinks): ESC ] … BEL or ST. */
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
/** Any other two-character escape, plus a dangling ESC at the end of a chunk. */
const ESC_OTHER = /\u001b[@-Z\\-_]?/g;
/** Control bytes except \n (rendered) and \t (expanded below). */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** A line segment erased by a carriage return (progress spinners rewrite lines). */
const CR_OVERWRITE = /[^\n]*\r/g;
/** An escape sequence cut in half by a chunk boundary — streamed tool output
 *  arrives in arbitrary slices, so the tail may be a partial CSI/OSC. */
const TRAILING_PARTIAL = /\u001b(?:\[[0-?]*[ -/]*|\][^\n\u0007\u001b]*)?$/;

/** Strip ANSI escapes and stray control bytes so text is safe inside a panel. */
export function sanitizeForDisplay(text: string): string {
  return text
    .replace(TRAILING_PARTIAL, "")
    .replace(CSI, "")
    .replace(OSC, "")
    .replace(ESC_OTHER, "")
    .replace(/\r\n/g, "\n")
    // Keep only the final state of a line that was rewritten with \r.
    .replace(CR_OVERWRITE, "")
    .replace(/\t/g, "  ")
    .replace(CONTROL, "");
}

/** Sanitize, then truncate to `max` display characters with an ellipsis.
 *  Sanitizing BEFORE slicing is what makes the cut safe — there are no escape
 *  sequences left to cut through. */
export function sanitizeAndTruncate(text: string, max: number): string {
  const clean = sanitizeForDisplay(text);
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)) + "…";
}
