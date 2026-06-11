import { describe, it, expect } from "vitest";
import { vimKey, initialVimState, type VimState } from "../vim.js";

// Apply a sequence of (input, key) steps, returning the final state (+ submit flag).
function run(start: VimState, steps: Array<[string, object?]>): { state: VimState; submit?: boolean } {
  let state = start;
  let submit: boolean | undefined;
  for (const [input, key] of steps) {
    const r = vimKey(state, input, key ?? {});
    state = r.state;
    submit = r.submit;
  }
  return { state, submit };
}

describe("vim modal editing (#184)", () => {
  it("enters insert mode and types text", () => {
    const { state } = run(initialVimState(""), [["i"], ["h"], ["e"], ["l"], ["l"], ["o"]]);
    expect(state.mode).toBe("insert");
    expect(state.value).toBe("hello");
    expect(state.cursor).toBe(5);
  });

  it("Esc returns to normal mode and moves left", () => {
    const { state } = run(initialVimState(""), [["i"], ["a"], ["b"], ["", { escape: true }]]);
    expect(state.mode).toBe("normal");
    expect(state.value).toBe("ab");
    expect(state.cursor).toBe(1);
  });

  it("h/l move and x deletes the char under the cursor", () => {
    let s = initialVimState("abc"); // normal mode, cursor 0
    s = vimKey(s, "l").state; // cursor 1
    s = vimKey(s, "x").state; // delete 'b'
    expect(s.value).toBe("ac");
    expect(s.cursor).toBe(1);
  });

  it("a appends after the cursor; A appends at end", () => {
    let s = initialVimState("ab"); // cursor 0
    const after = vimKey(s, "a").state;
    expect(after).toMatchObject({ mode: "insert", cursor: 1 });
    const end = vimKey(s, "A").state;
    expect(end).toMatchObject({ mode: "insert", cursor: 2 });
  });

  it("0 and $ jump to line start/end; D deletes to end", () => {
    let s = initialVimState("hello"); // cursor 0
    s = vimKey(s, "$").state;
    expect(s.cursor).toBe(4);
    s = vimKey(s, "0").state;
    expect(s.cursor).toBe(0);
    s = vimKey(s, "l").state; // cursor 1
    s = vimKey(s, "D").state; // delete from cursor to end
    expect(s.value).toBe("h");
  });

  it("Enter submits from normal and insert mode", () => {
    expect(vimKey(initialVimState("hi"), "", { return: true }).submit).toBe(true);
    const ins = vimKey(initialVimState("hi"), "i").state;
    expect(vimKey(ins, "", { return: true }).submit).toBe(true);
  });

  it("backspace deletes before the cursor in insert mode", () => {
    const { state } = run(initialVimState(""), [["i"], ["a"], ["b"], ["", { backspace: true }]]);
    expect(state.value).toBe("a");
    expect(state.cursor).toBe(1);
  });
});
