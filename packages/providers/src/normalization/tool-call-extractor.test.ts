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

describe("tagged <tool_call> blocks (MLX / Qwen / Hermes templates)", () => {
  const x = () => new ToolCallExtractor();

  it("extracts a single call and keeps the surrounding prose", () => {
    const raw = 'Let me look.\n<tool_call>\n{"name": "readFile", "arguments": {"path": "src/a.ts"}}\n</tool_call>';
    const r = x().extract(raw, "mlx");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].toolName).toBe("readFile");
    expect(JSON.parse(r.toolCalls[0].argumentsJson)).toEqual({ path: "src/a.ts" });
    expect(r.text).toBe("Let me look.");
    expect(r.text).not.toContain("tool_call");
  });

  it("extracts several calls from one response", () => {
    const raw =
      '<tool_call>{"name":"listDirectory","arguments":{"path":"."}}</tool_call>' +
      '<tool_call>{"name":"readFile","arguments":{"path":"README.md"}}</tool_call>';
    const r = x().extract(raw, "mlx");
    expect(r.toolCalls.map((t) => t.toolName)).toEqual(["listDirectory", "readFile"]);
    expect(new Set(r.toolCalls.map((t) => t.toolCallId)).size).toBe(2);
  });

  it("accepts `parameters` as an alias for `arguments`", () => {
    const r = x().extract('<tool_call>{"name":"search","parameters":{"q":"x"}}</tool_call>', "mlx");
    expect(JSON.parse(r.toolCalls[0].argumentsJson)).toEqual({ q: "x" });
  });

  it("repairs sloppy JSON rather than dropping the call", () => {
    const r = x().extract("<tool_call>{'name': 'readFile', 'arguments': {'path': 'a.ts',}}</tool_call>", "mlx");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].toolName).toBe("readFile");
  });

  it("leaves malformed blocks as text instead of inventing a call", () => {
    const raw = "<tool_call>not json at all</tool_call>";
    const r = x().extract(raw, "mlx");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.text).toContain("not json");
  });

  it("returns plain prose untouched when there are no calls", () => {
    const r = x().extract("Just an explanation, no tools needed.", "mlx");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.text).toBe("Just an explanation, no tools needed.");
  });

  // Qwen3-family templates put XML in the <tool_call> block, not JSON. The raw
  // string below is a verbatim response from Ornith-1.0-9B-MLX-4bit running on
  // the sidecar; the JSON-only parser dropped it silently and the turn looked
  // like the model had simply declined to use its tools.
  it("parses the XML function form Qwen3-family templates emit", () => {
    const raw =
      "I should use the listFiles tool.\n</think>\n\n<tool_call>\n<function=listFiles>\n<parameter=path>\nsrc\n</parameter>\n</function>\n</tool_call>";
    const r = x().extract(raw, "mlx");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].toolName).toBe("listFiles");
    expect(JSON.parse(r.toolCalls[0].argumentsJson)).toEqual({ path: "src" });
  });

  it("keeps multiple XML calls and their parameters distinct", () => {
    const raw =
      "<tool_call>\n<function=readFile>\n<parameter=path>\na.ts\n</parameter>\n</function>\n</tool_call>" +
      "<tool_call>\n<function=readFile>\n<parameter=path>\nb.ts\n</parameter>\n</function>\n</tool_call>";
    const r = x().extract(raw, "mlx");
    expect(r.toolCalls.map((c) => JSON.parse(c.argumentsJson).path)).toEqual(["a.ts", "b.ts"]);
  });

  it("coerces XML parameter text to JSON scalars", () => {
    const raw =
      "<tool_call>\n<function=head>\n<parameter=path>\na.ts\n</parameter>\n<parameter=lines>\n20\n</parameter>\n<parameter=raw>\ntrue\n</parameter>\n</function>\n</tool_call>";
    const r = x().extract(raw, "mlx");
    expect(JSON.parse(r.toolCalls[0].argumentsJson)).toEqual({
      path: "a.ts",
      lines: 20,
      raw: true,
    });
  });

  it("still rejects an XML block with no function name", () => {
    const raw = "<tool_call>\n<parameter=path>\nsrc\n</parameter>\n</tool_call>";
    const r = x().extract(raw, "mlx");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.text).toContain("parameter=path");
  });
});
