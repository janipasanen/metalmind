/**
 * A small vim modal editing state machine for the input bar (#184). Pure and
 * tested; the InputBar feeds it keystrokes and renders state.value/cursor/mode.
 * Supports the common motions/edits — enough to feel like vim without being a
 * full implementation.
 */

export type VimMode = "normal" | "insert";

export interface VimState {
  mode: VimMode;
  value: string;
  cursor: number;
}

export interface VimKey {
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}

export interface VimResult {
  state: VimState;
  /** True when the keystroke means "submit the buffer". */
  submit?: boolean;
}

export function initialVimState(value = ""): VimState {
  return { mode: "normal", value, cursor: 0 };
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

/** Apply one keystroke to the vim state. */
export function vimKey(state: VimState, input: string, key: VimKey = {}): VimResult {
  const { value } = state;
  const len = value.length;

  if (state.mode === "insert") {
    if (key.escape) {
      // Leave insert mode; vim moves the cursor left by one.
      return { state: { ...state, mode: "normal", cursor: clamp(state.cursor - 1, len) } };
    }
    if (key.return) return { state, submit: true };
    if (key.backspace || key.delete) {
      if (state.cursor === 0) return { state };
      const next = value.slice(0, state.cursor - 1) + value.slice(state.cursor);
      return { state: { ...state, value: next, cursor: state.cursor - 1 } };
    }
    if (input && !key.leftArrow && !key.rightArrow) {
      const next = value.slice(0, state.cursor) + input + value.slice(state.cursor);
      return { state: { ...state, value: next, cursor: state.cursor + input.length } };
    }
    return { state };
  }

  // normal mode
  switch (input) {
    case "i": return { state: { ...state, mode: "insert" } };
    case "I": return { state: { ...state, mode: "insert", cursor: 0 } };
    case "a": return { state: { ...state, mode: "insert", cursor: clamp(state.cursor + 1, len) } };
    case "A": return { state: { ...state, mode: "insert", cursor: len } };
    case "h": return { state: { ...state, cursor: clamp(state.cursor - 1, len) } };
    case "l": return { state: { ...state, cursor: clamp(state.cursor + 1, len) } };
    case "0": return { state: { ...state, cursor: 0 } };
    case "$": return { state: { ...state, cursor: Math.max(0, len - 1) } };
    case "x": {
      if (len === 0) return { state };
      const next = value.slice(0, state.cursor) + value.slice(state.cursor + 1);
      return { state: { ...state, value: next, cursor: clamp(state.cursor, next.length) } };
    }
    case "D": return { state: { ...state, value: value.slice(0, state.cursor) } };
    default:
      if (key.return) return { state, submit: true };
      return { state };
  }
}

export const VIM_HELP = [
  "Vim mode — keys:",
  "  NORMAL:  i/I insert (here/start)  a/A append (after/end)",
  "           h/l move  0/$ line start/end  x delete char  D delete to end",
  "           Enter submit",
  "  INSERT:  Esc → normal  Enter submit  type to insert",
  "  Toggle vim mode with /vim.",
].join("\n");
