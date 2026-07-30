import { describe, it, expect } from "vitest";
import { vimKey, initialVimState } from "../vim.js";

describe("vim ignores modifier chords (#385)", () => {
  it("does not type the chord letter in insert mode", () => {
    const insert = { ...initialVimState("hello"), mode: "insert" as const, cursor: 5 };
    const r = vimKey(insert, "p", { ctrl: true });
    expect(r.state.value).toBe("hello"); // NOT "hellop"
    expect(r.state.mode).toBe("insert");
  });

  it("does not fire a vim command in normal mode", () => {
    // "p" in normal mode is paste; Ctrl+P must not trigger it.
    const normal = { ...initialVimState("abc"), cursor: 1 };
    const before = { ...normal };
    const r = vimKey(normal, "p", { ctrl: true });
    expect(r.state).toEqual(before);
    expect(r.submit).toBeFalsy();

    // Ctrl+D must not act like the "d" delete operator either.
    const d = vimKey({ ...initialVimState("abc"), cursor: 0 }, "d", { ctrl: true });
    expect(d.state.value).toBe("abc");
  });

  it("still handles the same letters normally without a modifier", () => {
    const insert = { ...initialVimState("hell"), mode: "insert" as const, cursor: 4 };
    expect(vimKey(insert, "o", {}).state.value).toBe("hello");
    expect(vimKey(initialVimState("abc"), "i", {}).state.mode).toBe("insert");
  });

  it("ignores meta (Alt) chords too", () => {
    const insert = { ...initialVimState("x"), mode: "insert" as const, cursor: 1 };
    expect(vimKey(insert, "b", { meta: true }).state.value).toBe("x");
  });
});
