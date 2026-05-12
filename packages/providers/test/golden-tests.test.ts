import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fixturePath(name: string): string {
  return join(import.meta.dirname, "fixtures", name);
}
import type { AgentMessage, AgentToolCall } from "@metalmind/schemas";
import { loadConfigFromFile, CONFIG_FILE } from "@metalmind/config";
import { createProvider } from "../src/provider-factory.js";
import { OllamaProvider } from "../src/ollama/ollama-provider.js";

function normalizeClaudeToolCall(raw: Record<string, unknown>): {
  text: string;
  toolCalls: AgentToolCall[];
} {
  const content = raw.content as Array<Record<string, unknown>>;
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => (c.text as string) ?? "")
    .join("");

  const toolCalls: AgentToolCall[] = content
    .filter((c) => c.type === "tool_use")
    .map((c) => ({
      toolCallId: c.id as string,
      toolName: c.name as string,
      argumentsJson: JSON.stringify(c.input ?? {}),
    }));

  return { text, toolCalls };
}

function normalizeOpenAIToolCall(raw: {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}): AgentMessage {
  const choice = raw.choices[0];
  const msg: AgentMessage = {
    role: "assistant",
    content: choice.message.content ?? "",
  };

  if (choice.message.tool_calls?.length) {
    msg.toolCalls = choice.message.tool_calls.map((tc) => ({
      toolCallId: tc.id,
      toolName: tc.function.name,
      argumentsJson: tc.function.arguments,
    }));
  }

  return msg;
}

function extractMarkdownJson(text: string): AgentToolCall | null {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (parsed.tool && parsed.arguments) {
      return {
        toolCallId: `extracted-${Date.now()}`,
        toolName: parsed.tool,
        argumentsJson: JSON.stringify(parsed.arguments),
      };
    }
  } catch {
    return null;
  }

  return null;
}

describe("golden tests — provider output normalization", () => {
  describe("Claude tool-call fixture", () => {
    it("parses into internal AgentToolCall format", () => {
      const raw = JSON.parse(
        readFileSync(
          fixturePath("claude-tool-call.json"),
          "utf-8",
        ),
      ) as Record<string, unknown>;

      const { text, toolCalls } = normalizeClaudeToolCall(raw);

      expect(text).toBe("I will search for authentication implementation.");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe("searchInFiles");
      expect(toolCalls[0].toolCallId).toBeTruthy();
      expect(JSON.parse(toolCalls[0].argumentsJson)).toEqual({
        pattern: "authenticate",
        path: "src/",
      });
    });
  });

  describe("OpenAI tool-call fixture", () => {
    it("parses into internal AgentMessage format", () => {
      const raw = JSON.parse(
        readFileSync(
          fixturePath("openai-tool-call.json"),
          "utf-8",
        ),
      );

      const msg = normalizeOpenAIToolCall(raw);

      expect(msg.role).toBe("assistant");
      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0].toolName).toBe("readFile");
      expect(msg.toolCalls![0].toolCallId).toBe("call_abc123");
    });
  });

  describe("Gemini markdown JSON fixture", () => {
    it("extracts JSON from markdown code blocks", () => {
      const text = readFileSync(
        fixturePath("gemini-markdown-json.md"),
        "utf-8",
      );

      const extracted = extractMarkdownJson(text);

      expect(extracted).not.toBeNull();
      expect(extracted!.toolName).toBe("readFile");
      expect(JSON.parse(extracted!.argumentsJson)).toEqual({
        path: "src/auth/login.ts",
      });
    });
  });

  describe("Ollama raw output fixture", () => {
    it("finds tool call in mixed prose and code blocks", () => {
      const text = readFileSync(
        fixturePath("ollama-raw-output.txt"),
        "utf-8",
      );

      const extracted = extractMarkdownJson(text);

      expect(extracted).not.toBeNull();
      expect(extracted!.toolName).toBe("readFile");
    });
  });

  describe("DeepSeek invalid JSON fixture", () => {
    it("extracts tool calls from custom text format", () => {
      const text = readFileSync(
        fixturePath("deepseek-invalid-json.txt"),
        "utf-8",
      );

      const match = text.match(
        /\[TOOL_CALL:\s*(\w+)\]\s*\nARGS:\s*(\{[\s\S]*?\})/,
      );

      expect(match).not.toBeNull();
      expect(match![1]).toBe("readFile");
      expect(JSON.parse(match![2].trim())).toEqual({ path: "src/main.ts" });
    });
  });
});

describe("integration test — config + provider", () => {
  const testDir = join(tmpdir(), `metalmind-integration-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads config and creates provider from it", () => {
    const yaml = `models:
  local:
    provider: ollama
    model: deepseek-coder:1.3b
routing:
  defaultLocalModel: local
  defaultReasoningModel: local
permissions:
  allowReadFiles: true
`;
    writeFileSync(join(testDir, CONFIG_FILE), yaml);

    const cfg = loadConfigFromFile(testDir);
    const modelConfig = cfg.models.local!;

    expect(modelConfig.provider).toBe("ollama");
    expect(modelConfig.model).toBe("deepseek-coder:1.3b");

    const provider = createProvider(
      modelConfig.provider,
      modelConfig.model,
      { baseUrl: modelConfig.baseUrl },
    );

    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.providerName).toBe("ollama");
    expect(provider.supportedCapabilities.supportsStreaming).toBe(true);
    expect(provider.supportedCapabilities.supportsToolCalling).toBe(true);
  });
});
