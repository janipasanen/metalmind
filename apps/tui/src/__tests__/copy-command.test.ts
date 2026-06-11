import { describe, it, expect } from "vitest";
import { extractLastCodeBlock, lastAssistantMessage, handleCopyCommand } from "../copy-command.js";

describe("copy extraction (#172)", () => {
  it("extracts the last fenced code block body without fences", () => {
    const text = "intro\n```ts\nconst a = 1;\n```\nmid\n```py\nprint('x')\n```\nend";
    expect(extractLastCodeBlock(text)).toBe("print('x')");
  });

  it("returns null when there's no code block", () => {
    expect(extractLastCodeBlock("just prose")).toBeNull();
  });

  it("finds the last non-empty assistant message", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: "first" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "second" },
    ];
    expect(lastAssistantMessage(msgs)).toBe("second");
    expect(lastAssistantMessage([{ role: "user", content: "x" }])).toBeNull();
  });

  it("reports nothing-to-copy and missing-code-block paths", () => {
    expect(handleCopyCommand("last", [])).toContain("Nothing to copy");
    expect(handleCopyCommand("code", [{ role: "assistant", content: "no code here" }])).toContain("No code block");
  });
});
