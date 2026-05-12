import { describe, it, expect } from "vitest";
import type {
  ModelProvider,
  ModelCapabilities,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelStreamEvent,
  TokenCountRequest,
  TokenCountResponse,
} from "./agent-runtime.js";
import type { AgentMessage, AgentToolCall } from "@metalmind/schemas";

function makeProvider(caps: ModelCapabilities): ModelProvider {
  return {
    providerName: "test",
    supportedCapabilities: caps,
    async *streamChatCompletion(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text", text: "hello" };
      yield { type: "done" };
    },
    async completeChat(
      _request: ChatCompletionRequest,
    ): Promise<ChatCompletionResponse> {
      return { message: { role: "assistant", content: "ok" } };
    },
    async countTokens(
      _request: TokenCountRequest,
    ): Promise<TokenCountResponse> {
      return { tokenCount: 5 };
    },
  };
}

describe("ModelProvider", () => {
  it("has providerName and supportedCapabilities", () => {
    const caps: ModelCapabilities = {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: true,
      maximumContextTokens: 128_000,
    };
    const p = makeProvider(caps);
    expect(p.providerName).toBe("test");
    expect(p.supportedCapabilities.supportsStreaming).toBe(true);
    expect(p.supportedCapabilities.maximumContextTokens).toBe(128_000);
  });

  it("streamChatCompletion yields text and done events", async () => {
    const p = makeProvider({
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: false,
      maximumContextTokens: 4096,
    });

    const events: ModelStreamEvent[] = [];
    for await (const e of p.streamChatCompletion({ messages: [] })) {
      events.push(e);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text", text: "hello" });
    expect(events[1]).toEqual({ type: "done" });
  });

  it("completeChat returns assistant message", async () => {
    const p = makeProvider({
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: false,
      maximumContextTokens: 4096,
    });

    const res = await p.completeChat({ messages: [] });
    expect(res.message.role).toBe("assistant");
    expect(res.message.content).toBe("ok");
  });

  it("countTokens is optional and can return token count", async () => {
    const p = makeProvider({
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: false,
      maximumContextTokens: 4096,
    });

    if (p.countTokens) {
      const res = await p.countTokens({ messages: [] });
      expect(res.tokenCount).toBe(5);
    } else {
      expect(p.countTokens).toBeDefined();
    }
  });

  it("supports tool-call stream events", () => {
    const toolCallEvent: ModelStreamEvent = {
      type: "tool-call",
      toolCall: {
        toolCallId: "tc1",
        toolName: "readFile",
        argumentsJson: '{"path":"/test"}',
      },
    };

    expect(toolCallEvent.type).toBe("tool-call");
    expect(toolCallEvent.toolCall.toolCallId).toBe("tc1");
  });
});

describe("ChatCompletionRequest", () => {
  it("accepts messages array with optional tools", () => {
    const msg: AgentMessage = { role: "user", content: "hi" };
    const request: ChatCompletionRequest = {
      messages: [msg],
      tools: [],
      stream: true,
    };
    expect(request.messages).toHaveLength(1);
    expect(request.tools).toEqual([]);
    expect(request.stream).toBe(true);
  });

  it("works without tools and stream", () => {
    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "You are a bot." },
        { role: "user", content: "Question" },
      ],
    };
    expect(request.messages).toHaveLength(2);
    expect(request.tools).toBeUndefined();
    expect(request.stream).toBeUndefined();
  });
});

describe("AgentMessage / AgentToolCall conformance", () => {
  it("AgentMessage supports all four roles", () => {
    const roles = ["system", "user", "assistant", "tool"] as const;
    for (const role of roles) {
      const msg: AgentMessage = { role, content: "test" };
      expect(msg.role).toBe(role);
    }
  });

  it("AgentMessage supports toolCalls and metadata", () => {
    const toolCall: AgentToolCall = {
      toolCallId: "abc",
      toolName: "search",
      argumentsJson: "{}",
    };
    const msg: AgentMessage = {
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
      metadata: { model: "test" },
    };
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.metadata?.model).toBe("test");
  });
});

describe("ModelCapabilities match spec requirements", () => {
  it("covers all required capability fields", () => {
    const caps: ModelCapabilities = {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsJsonMode: true,
      maximumContextTokens: 200_000,
    };
    expect(Object.keys(caps)).toHaveLength(6);
  });

  it("different providers can have different capabilities", () => {
    const localCaps: ModelCapabilities = {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: true,
      maximumContextTokens: 32_000,
    };

    const cloudCaps: ModelCapabilities = {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsJsonMode: true,
      maximumContextTokens: 256_000,
    };

    expect(localCaps.supportsReasoning).toBe(false);
    expect(cloudCaps.supportsReasoning).toBe(true);
    expect(cloudCaps.maximumContextTokens).toBeGreaterThan(localCaps.maximumContextTokens);
  });
});
