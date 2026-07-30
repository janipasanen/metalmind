import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUserCommands, expandUserCommand } from "../user-commands.js";

describe("user-defined slash commands (gap-5)", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `mm-ucmd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, ".metalmind", "commands"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("loads project commands with the first line as description", () => {
    writeFileSync(
      join(root, ".metalmind", "commands", "review.md"),
      "# Review the current diff\nReview the staged changes and list issues.",
    );
    const cmds = loadUserCommands(root);
    const review = cmds.find((c) => c.name === "review");
    expect(review).toBeDefined();
    expect(review!.description).toBe("Review the current diff");
    expect(review!.template).toContain("Review the staged changes");
  });

  it("substitutes $ARGUMENTS, or appends args without the placeholder", () => {
    const withPh = { name: "x", template: "Fix the bug in $ARGUMENTS and add a test.", description: "" };
    expect(expandUserCommand(withPh, "src/a.ts")).toBe("Fix the bug in src/a.ts and add a test.");

    const noPh = { name: "y", template: "Summarize the repo.", description: "" };
    expect(expandUserCommand(noPh, "briefly")).toBe("Summarize the repo.\n\nbriefly");
    expect(expandUserCommand(noPh, "")).toBe("Summarize the repo.");
  });

  it("ignores invalid names, empty files, and missing dirs", () => {
    writeFileSync(join(root, ".metalmind", "commands", "bad name!.md"), "content");
    writeFileSync(join(root, ".metalmind", "commands", "empty.md"), "   ");
    const cmds = loadUserCommands(root);
    expect(cmds.find((c) => c.name.includes("bad"))).toBeUndefined();
    expect(cmds.find((c) => c.name === "empty")).toBeUndefined();
    // A root with no commands dir at all:
    expect(loadUserCommands(join(root, "nope"))).toEqual([]);
  });
});
