import { describe, it, expect } from "vitest";
import { MetalmindConfigSchema } from "../src/config.js";

describe("MetalmindConfigSchema", () => {
  it("parses a minimal valid config", () => {
    const raw = {
      models: {
        local: { provider: "ollama", model: "deepseek-coder:1.3b" },
      },
    };
    expect(MetalmindConfigSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects missing models", () => {
    expect(MetalmindConfigSchema.safeParse({}).success).toBe(false);
  });

  it("parses full config with all options", () => {
    const raw = {
      models: {
        localFast: { provider: "ollama", model: "deepseek-coder:1.3b" },
        cloudReasoning: { provider: "anthropic", model: "claude-sonnet-latest", apiKey: "sk-..." },
      },
      routing: {
        defaultLocalModel: "localFast",
        defaultReasoningModel: "cloudReasoning",
      },
      permissions: {
        allowReadFiles: true,
        allowWriteFiles: "ask",
      },
      tools: {
        filesystem: true,
        git: false,
      },
      ui: {
        theme: "dark",
      },
    };
    const result = MetalmindConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("uses defaults when fields are undefined but section is present", () => {
    const raw = {
      models: { local: { provider: "ollama", model: "test" } },
      permissions: {},
    };
    const result = MetalmindConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions?.allowReadFiles).toBe(true);
      expect(result.data.permissions?.allowWriteFiles).toBe("ask");
    }
  });
});
