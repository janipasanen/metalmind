/**
 * Extracts tool calls from various model output formats:
 * - OpenAI function_call / tool_calls format
 * - Anthropic content blocks
 * - Markdown-wrapped JSON code fences
 * - Custom [TOOL_CALL: name] format
 * - Bare JSON objects with tool/args keys
 */
import type { AgentToolCall } from "@metalmind/schemas";
import { JsonRepair } from "./json-repair.js";

interface ToolCallExtract {
  text: string;
  toolCalls: AgentToolCall[];
}

export class ToolCallExtractor {
  private counter = 0;

  extract(raw: string, provider?: string): ToolCallExtract {
    this.counter = 0;

    switch (provider) {
      case "ollama":
        return this.extractOllama(raw);
      default:
        return this.extractUniversal(raw);
    }
  }

  private extractOllama(raw: string): ToolCallExtract {
    // Try markdown JSON code fences first
    const fence = this.extractFromMarkdownFence(raw);
    if (fence.toolCalls.length > 0) return fence;

    // Try bare JSON objects
    const bare = this.extractBareJson(raw);
    if (bare.toolCalls.length > 0) return bare;

    // Try custom [TOOL_CALL: ...] format
    const custom = this.extractCustomFormat(raw);
    if (custom.toolCalls.length > 0) return custom;

    return { text: raw, toolCalls: [] };
  }

  private extractUniversal(raw: string): ToolCallExtract {
    return this.extractFromMarkdownFence(raw);
  }

  private extractFromMarkdownFence(raw: string): ToolCallExtract {
    const match = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (!match) return { text: raw, toolCalls: [] };

    let json = match[1].trim();
    json = JsonRepair.repair(json);

    try {
      const parsed = JSON.parse(json);

      // Anthropic-style: { tool: "name", input: {...} } — check before OpenAI style
      if (parsed.tool && typeof parsed.tool === "string" && parsed.input) {
        const tc: AgentToolCall = {
          toolCallId: this.nextId(),
          toolName: parsed.tool,
          argumentsJson: JSON.stringify(parsed.input),
        };
        const text = raw.replace(match[0], "").trim();
        return { text, toolCalls: [tc] };
      }

      // OpenAI-style: { tool: "name", arguments: {...} }
      if (parsed.tool && typeof parsed.tool === "string") {
        const tc: AgentToolCall = {
          toolCallId: this.nextId(),
          toolName: parsed.tool,
          argumentsJson: JSON.stringify(parsed.arguments ?? {}),
        };
        const text = raw.replace(match[0], "").trim();
        return { text, toolCalls: [tc] };
      }
    } catch {
      // JSON repair failed, fall through
    }

    return { text: raw, toolCalls: [] };
  }

  private extractBareJson(raw: string): ToolCallExtract {
    const jsonMatch = raw.match(/(\{[\s\S]*?"tool"[\s\S]*?"arguments"[\s\S]*?\})/);
    if (!jsonMatch) return { text: raw, toolCalls: [] };

    const json = JsonRepair.repair(jsonMatch[1]);
    try {
      const parsed = JSON.parse(json);
      if (parsed.tool && parsed.arguments) {
        const tc: AgentToolCall = {
          toolCallId: this.nextId(),
          toolName: parsed.tool,
          argumentsJson: JSON.stringify(parsed.arguments),
        };
        const text = raw.replace(jsonMatch[0], "").trim();
        return { text, toolCalls: [tc] };
      }
    } catch {
      // skip
    }

    return { text: raw, toolCalls: [] };
  }

  private extractCustomFormat(raw: string): ToolCallExtract {
    const match = raw.match(/\[TOOL_CALL:\s*(\w+)\]\s*\nARGS:\s*(\{[\s\S]*?\})/);
    if (!match) return { text: raw, toolCalls: [] };

    const args = JsonRepair.repair(match[2].trim());
    try {
      JSON.parse(args);
    } catch {
      return { text: raw, toolCalls: [] };
    }

    const tc: AgentToolCall = {
      toolCallId: this.nextId(),
      toolName: match[1],
      argumentsJson: args,
    };
    const text = raw.replace(match[0], "").trim();
    return { text, toolCalls: [tc] };
  }

  private nextId(): string {
    return `extracted-${++this.counter}-${Math.random().toString(36).slice(2, 6)}`;
  }
}
