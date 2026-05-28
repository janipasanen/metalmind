import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveConfig } from "../config.js";
import * as configPkg from "@metalmind/config";

vi.mock("@metalmind/config", async () => {
  const actual = await vi.importActual("@metalmind/config");
  return {
    ...actual,
    loadMergedConfig: vi.fn(),
  };
});

describe("resolveConfig Priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.METALMIND_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    
    // Default mock behavior
    (configPkg.loadMergedConfig as any).mockReturnValue({
      activeProvider: "",
      apiKeys: {},
    });
  });

  it("prioritizes global config activeProvider over env var auto-detection", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    (configPkg.loadMergedConfig as any).mockReturnValue({
      activeProvider: "ollama",
      apiKeys: {},
    });

    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("ollama");
  });

  it("prioritizes OLLAMA_API_KEY over ANTHROPIC_API_KEY in auto-detection", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OLLAMA_API_KEY = "test-ollama-key";
    
    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.apiKey).toBe("test-ollama-key");
  });

  it("defaults to ollama if no keys and no config", () => {
    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("ollama");
  });

  it("allows overriding config with METALMIND_PROVIDER env var", () => {
    (configPkg.loadMergedConfig as any).mockReturnValue({
      activeProvider: "ollama",
      apiKeys: {},
    });
    process.env.METALMIND_PROVIDER = "openai";

    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("openai");
  });

  it("allows overriding config and env with CLI flag", () => {
    (configPkg.loadMergedConfig as any).mockReturnValue({
      activeProvider: "ollama",
      apiKeys: {},
    });
    process.env.METALMIND_PROVIDER = "openai";

    const cfg = resolveConfig(["--provider", "anthropic"]);
    expect(cfg.provider).toBe("anthropic");
  });
});
