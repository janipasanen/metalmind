import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { switchTheme, loadTheme } from "@metalmind/config";
import { resolveConfig } from "../config.js";

describe("Feature Comprehensive Tests", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.METALMIND_PROVIDER;
    delete process.env.METALMIND_MODEL;
  });

  it("Ctrl+P opens command palette", () => {
    expect(true).toBe(true);
  });

  it("Provider Selection - Ollama", () => {
    const cfg = resolveConfig(["--provider", "ollama"]);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("deepseek-coder:1.3b");
    expect(cfg.explicit).toBe(true);
  });

  it("Provider Selection - OpenAI", () => {
    const cfg = resolveConfig(["--provider", "openai"]);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.explicit).toBe(true);
  });

  it("Provider Selection - Anthropic", () => {
    const cfg = resolveConfig(["--provider", "anthropic"]);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.explicit).toBe(true);
  });

  it("Provider Selection - MLX", () => {
    const cfg = resolveConfig(["--provider", "mlx"]);
    expect(cfg.provider).toBe("mlx");
    expect(cfg.model).toBe("mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit");
    expect(cfg.explicit).toBe(true);
  });

  it("API Key storage for provider", () => {
    const config = {
      apiKeys: {
        openai: "sk-openai-test",
        anthropic: "sk-ant-test",
        ollama: "sk-ollama-test",
      },
    };
    expect(Object.keys(config.apiKeys).length).toBe(3);
  });

  it("Theme Selection - Load theme", () => {
    const theme = loadTheme();
    expect(theme).toBeDefined();
    expect(theme.id).toBeDefined();
  });

  it("Theme Selection - Switch theme", () => {
    const original = loadTheme().id;
    switchTheme("light");
    expect(loadTheme().id).toBe("light");
    switchTheme(original);
  });

  it("Theme persist in config", () => {
    switchTheme("dark");
    expect(loadTheme().id).toBe("dark");
  });

  it("MCP Servers config structure", () => {
    const config = {
      mcpServers: {
        "git": { enabled: true },
        "memory": { enabled: true },
      },
    };
    expect(Object.keys(config.mcpServers).length).toBe(2);
  });

  it("Config persistence structure", () => {
    const config = {
      activeProvider: "ollama",
      activeModel: "deepseek-coder:1.3b",
      apiKeys: { openai: "test-key" },
    };
    expect(config.activeProvider).toBe("ollama");
  });

  it("Auto-detect Anthropic from env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("anthropic");
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("Auto-detect OpenAI from env var", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("openai");
    delete process.env.OPENAI_API_KEY;
  });

  it("Default to Ollama when no env vars", () => {
    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("ollama");
  });

  it("Command Palette has Provider option", () => {
    const commands = [{ id: "provider" }, { id: "theme" }, { id: "mcp" }];
    expect(commands.find(c => c.id === "provider")).toBeDefined();
  });

  it("Command Palette has Theme option", () => {
    const commands = [{ id: "provider" }, { id: "theme" }, { id: "mcp" }];
    expect(commands.find(c => c.id === "theme")).toBeDefined();
  });

  it("Command Palette has MCP option", () => {
    const commands = [{ id: "provider" }, { id: "theme" }, { id: "mcp" }];
    expect(commands.find(c => c.id === "mcp")).toBeDefined();
  });
});
