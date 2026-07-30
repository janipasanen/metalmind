import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHooks, runHooks } from "../lifecycle-hooks.js";

describe("user lifecycle hooks (#346)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `mm-hooks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, ".metalmind"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("loads project hooks and skips invalid entries", () => {
    writeFileSync(
      join(root, ".metalmind", "hooks.json"),
      JSON.stringify({
        preTool: [{ matcher: "runCommand", command: "echo hi" }, { command: "" }, { nope: true }],
        stop: [{ command: "echo bye" }],
        garbage: "ignored",
      }),
    );
    const hooks = loadHooks(root);
    expect(hooks.preTool).toHaveLength(1);
    expect(hooks.preTool![0].matcher).toBe("runCommand");
    expect(hooks.stop).toHaveLength(1);
    expect(hooks.postTool).toBeUndefined();
  });

  it("returns empty hooks for a missing or malformed file", () => {
    expect(loadHooks(root)).toEqual({});
    writeFileSync(join(root, ".metalmind", "hooks.json"), "{not json");
    expect(loadHooks(root)).toEqual({});
  });

  it("a preTool hook exiting 2 blocks the call with its output as the reason", async () => {
    const hooks = { preTool: [{ command: "echo denied by policy; exit 2" }] };
    const out = await runHooks(hooks, "preTool", root, { MM_TOOL_NAME: "runCommand", MM_TOOL_INPUT: "{}" });
    expect(out.blocked).toContain("denied by policy");
  });

  it("matcher limits a hook to matching tool names", async () => {
    const hooks = { preTool: [{ matcher: "^gitCommit$", command: "exit 2" }] };
    const other = await runHooks(hooks, "preTool", root, { MM_TOOL_NAME: "readFile" });
    expect(other.blocked).toBeUndefined();
    const match = await runHooks(hooks, "preTool", root, { MM_TOOL_NAME: "gitCommit" });
    expect(match.blocked).toBeTruthy();
  });

  it("delivers context through MM_* env vars and collects notes", async () => {
    const hooks = { postTool: [{ command: "echo saw:$MM_TOOL_NAME" }] };
    const out = await runHooks(hooks, "postTool", root, { MM_TOOL_NAME: "editFile", MM_TOOL_OUTPUT: "ok" });
    expect(out.blocked).toBeUndefined();
    expect(out.notes.join("\n")).toContain("saw:editFile");
  });
});
