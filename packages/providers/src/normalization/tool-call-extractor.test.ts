import { describe, it, expect } from "vitest";
import { ToolCallExtractor } from "./tool-call-extractor.js";

describe("ToolCallExtractor", () => {
  const extractor = new ToolCallExtractor();

  it("extracts tool call from markdown JSON fence (OpenAI style)", () => {
    const raw = `Let me read the file.
\`\`\`json
{
  "tool": "readFile",
  "arguments": {
    "path": "src/auth.ts"
  }
}
\`\`\`
`;
    const result = extractor.extract(raw, "ollama");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("readFile");
    expect(JSON.parse(result.toolCalls[0].argumentsJson)).toEqual({
      path: "src/auth.ts",
    });
  });

  it("extracts from bare markdown fence (no json tag)", () => {
    const raw = `\`\`\`
{
  "tool": "searchInFiles",
  "arguments": {
    "pattern": "auth",
    "path": "src/"
  }
}
\`\`\`
`;
    const result = extractor.extract(raw, "ollama");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("searchInFiles");
  });

  it("extracts Anthropic-style input format", () => {
    const raw = `\`\`\`json
{
  "tool": "readFile",
  "input": {
    "path": "/test.ts"
  }
}
\`\`\`
`;
    const result = extractor.extract(raw, "ollama");
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].argumentsJson)).toEqual({
      path: "/test.ts",
    });
  });

  it("removes tool call text from output text", () => {
    const raw = `I'll search now.\n\`\`\`json\n{"tool": "findFiles", "arguments": {"pattern": "*.ts"}}\n\`\`\``;
    const result = extractor.extract(raw, "ollama");
    expect(result.text).not.toContain("```");
    expect(result.text).toContain("I'll search now.");
  });

  it("extracts custom [TOOL_CALL: ...] format", () => {
    const raw = `[TOOL_CALL: readFile]
ARGS: {"path": "src/main.ts"}
Done.`;
    const result = extractor.extract(raw, "ollama");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("readFile");
  });

  it("returns empty toolCalls for plain text", () => {
    const result = extractor.extract("Hello, how can I help?", "ollama");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("handles multiple tool calls in one response", () => {
    const raw = `First call:\n\`\`\`json\n{"tool": "readFile", "arguments": {"path": "a.ts"}}\n\`\`\`\nSecond call:\n\`\`\`json\n{"tool": "readFile", "arguments": {"path": "b.ts"}}\n\`\`\`\n`;
    const result = extractor.extract(raw, "ollama");
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].argumentsJson).path).toBe("a.ts");
  });
});
