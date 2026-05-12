import { describe, it, expect } from "vitest";

function processCommand(text: string, modelName: string): {
  messages: Array<{ role: string; content: string }>;
  modelName: string;
  shouldExit: boolean;
  shouldClear: boolean;
} {
  const result = {
    messages: [] as Array<{ role: string; content: string }>,
    modelName,
    shouldExit: false,
    shouldClear: false,
  };

  const trimmed = text.trim();
  if (!trimmed) return result;

  if (trimmed.startsWith("/model ")) {
    const newModel = trimmed.slice(7).trim();
    result.modelName = newModel;
    result.messages.push({
      role: "system",
      content: `Switched to model: ${newModel}`,
    });
  } else if (trimmed === "/help") {
    result.messages.push({
      role: "system",
      content: `Available commands:\n  /help - Show this help\n  /model <name> - Switch model\n  /clear - Clear chat\n  /quit - Exit`,
    });
  } else if (trimmed === "/clear") {
    result.shouldClear = true;
  } else if (trimmed === "/quit") {
    result.shouldExit = true;
    result.messages.push({ role: "user", content: trimmed });
  } else {
    result.messages.push({ role: "user", content: trimmed });
  }

  return result;
}

describe("TUI command processing", () => {
  it("switches model with /model command", () => {
    const result = processCommand("/model anthropic/claude", "ollama/test");
    expect(result.modelName).toBe("anthropic/claude");
    expect(result.messages[0].role).toBe("system");
  });

  it("shows help with /help", () => {
    const result = processCommand("/help", "local");
    expect(result.messages[0].content).toContain("/help");
    expect(result.messages[0].content).toContain("/model");
    expect(result.messages[0].content).toContain("/quit");
  });

  it("exits with /quit", () => {
    const result = processCommand("/quit", "local");
    expect(result.shouldExit).toBe(true);
  });

  it("clears with /clear", () => {
    const result = processCommand("/clear", "local");
    expect(result.shouldClear).toBe(true);
  });

  it("returns user message for regular text", () => {
    const result = processCommand("Hello, can you help me?", "local");
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello, can you help me?");
  });

  it("handles empty input", () => {
    const result = processCommand("", "local");
    expect(result.messages).toHaveLength(0);
  });
});

describe("truncate helper", () => {
  function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + "...";
  }

  it("returns short text unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long text", () => {
    expect(truncate("this is a very long text", 12)).toBe("this is a...");
  });

  it("handles exact length", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });
});
