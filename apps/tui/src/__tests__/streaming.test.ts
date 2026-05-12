import { describe, it, expect } from "vitest";

type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCall: { toolName: string; argumentsJson: string } }
  | { type: "tool-result"; output: string }
  | { type: "done" }
  | { type: "error"; message: string };

interface Message {
  role: string;
  content: string;
  toolCalls?: Array<{
    toolName: string;
    argumentsJson: string;
    output?: string;
  }>;
}

async function simulateChat(
  events: AsyncGenerator<ChatStreamEvent>,
): Promise<{
  messages: Message[];
  finalContent: string;
  toolCalls: Array<{ toolName: string; argumentsJson: string; output?: string }>;
}> {
  let streamingContent = "";
  const toolCalls: Array<{ toolName: string; argumentsJson: string; output?: string }> = [];
  const messages: Message[] = [];
  let error: string | null = null;

  for await (const event of events) {
    switch (event.type) {
      case "text":
        streamingContent += event.text;
        break;
      case "tool-call":
        toolCalls.push({
          toolName: event.toolCall.toolName,
          argumentsJson: event.toolCall.argumentsJson,
        });
        break;
      case "tool-result": {
        const last = toolCalls[toolCalls.length - 1];
        if (last) last.output = event.output;
        break;
      }
      case "error":
        error = event.message;
        break;
      case "done":
        messages.push({
          role: "assistant",
          content: streamingContent,
          toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
        });
        streamingContent = "";
        break;
    }
  }

  if (error) {
    messages.push({ role: "system", content: `Error: ${error}` });
  }

  return { messages, finalContent: streamingContent, toolCalls };
}

describe("streaming chat simulation", () => {
  it("accumulates text events into streaming content", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: "text", text: "Hello" };
      yield { type: "text", text: " World" };
      yield { type: "done" };
    }

    const result = await simulateChat(stream());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Hello World");
  });

  it("handles tool calls with results", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield {
        type: "tool-call",
        toolCall: { toolName: "readFile", argumentsJson: '{"path":"/test"}' },
      };
      yield { type: "tool-result", output: "file contents here" };
      yield { type: "done" };
    }

    const result = await simulateChat(stream());
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("readFile");
    expect(result.toolCalls[0].output).toBe("file contents here");
  });

  it("interleaves text and tool calls", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: "text", text: "I'll read the file." };
      yield {
        type: "tool-call",
        toolCall: { toolName: "readFile", argumentsJson: '{"path":"/a.ts"}' },
      };
      yield { type: "tool-result", output: "const x = 1;" };
      yield { type: "text", text: "\nDone." };
      yield { type: "done" };
    }

    const result = await simulateChat(stream());
    expect(result.messages[0].content).toBe("I'll read the file.\nDone.");
    expect(result.messages[0].toolCalls).toHaveLength(1);
  });

  it("handles errors gracefully", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: "error", message: "Network timeout" };
    }

    const result = await simulateChat(stream());
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("Error");
  });

  it("handles empty stream", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: "done" };
    }

    const result = await simulateChat(stream());
    expect(result.messages[0].content).toBe("");
  });

  it("handles multiple tool calls sequentially", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield {
        type: "tool-call",
        toolCall: { toolName: "readFile", argumentsJson: '{"path":"/a"}' },
      };
      yield { type: "tool-result", output: "content a" };
      yield {
        type: "tool-call",
        toolCall: { toolName: "readFile", argumentsJson: '{"path":"/b"}' },
      };
      yield { type: "tool-result", output: "content b" };
      yield { type: "done" };
    }

    const result = await simulateChat(stream());
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].output).toBe("content a");
    expect(result.toolCalls[1].output).toBe("content b");
  });

  it("shows streaming content state before done", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: "text", text: "partial" };
    }

    const result = await simulateChat(stream());
    expect(result.finalContent).toBe("partial");
    expect(result.messages).toHaveLength(0);
  });

  it("clears streaming content on done", async () => {
    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      yield { type: "text", text: "Hello" };
      yield { type: "done" };
    }

    const result = await simulateChat(stream());
    expect(result.finalContent).toBe("");
    expect(result.messages).toHaveLength(1);
  });
});
