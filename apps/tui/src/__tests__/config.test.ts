import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("resolveConfig", () => {
  beforeEach(() => {
    delete process.env.METALMIND_PROVIDER;
    delete process.env.METALMIND_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.METALMIND_BASE_URL;
  });

  it("falls back to ollama when no env vars set", () => {
    const cfg = resolveConfig([]);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("deepseek-coder:1.3b");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("auto-detects anthropic from ANTHROPIC_API_KEY", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("anthropic");
      expect(cfg.model).toBe("claude-sonnet-4-6");
      expect(cfg.apiKey).toBe("sk-ant-test");
    });
  });

  it("auto-detects openai from OPENAI_API_KEY when no anthropic key", () => {
    withEnv({ OPENAI_API_KEY: "sk-openai-test" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("openai");
      expect(cfg.model).toBe("gpt-4o");
      expect(cfg.apiKey).toBe("sk-openai-test");
    });
  });

  it("anthropic takes priority over openai when both keys present", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("anthropic");
    });
  });

  it("respects METALMIND_PROVIDER env var", () => {
    withEnv({ METALMIND_PROVIDER: "ollama" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("ollama");
    });
  });

  it("respects METALMIND_MODEL env var", () => {
    withEnv({ METALMIND_PROVIDER: "ollama", METALMIND_MODEL: "llama3:8b" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.model).toBe("llama3:8b");
    });
  });

  it("--provider flag overrides env var", () => {
    withEnv({ METALMIND_PROVIDER: "openai" }, () => {
      const cfg = resolveConfig(["--provider", "ollama"]);
      expect(cfg.provider).toBe("ollama");
    });
  });

  it("--model flag sets model", () => {
    const cfg = resolveConfig(["--model", "llama3:70b"]);
    expect(cfg.model).toBe("llama3:70b");
  });

  it("supports --provider=value syntax", () => {
    const cfg = resolveConfig(["--provider=ollama", "--model=mistral"]);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("mistral");
  });

  it("reads METALMIND_BASE_URL", () => {
    withEnv({ METALMIND_BASE_URL: "http://localhost:11434" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.baseUrl).toBe("http://localhost:11434");
    });
  });

  it("selects mlx with its default model and sidecar base URL", () => {
    const cfg = resolveConfig(["--provider", "mlx"]);
    expect(cfg.provider).toBe("mlx");
    expect(cfg.model).toBe("mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8742");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("lets METALMIND_BASE_URL override the mlx sidecar default", () => {
    withEnv({ METALMIND_PROVIDER: "mlx", METALMIND_BASE_URL: "http://127.0.0.1:9000" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("mlx");
      expect(cfg.baseUrl).toBe("http://127.0.0.1:9000");
    });
  });

  it("reads OLLAMA_API_KEY and defaults to Ollama Cloud base URL", () => {
    withEnv({ METALMIND_PROVIDER: "ollama", OLLAMA_API_KEY: "sk-ollama" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("ollama");
      expect(cfg.apiKey).toBe("sk-ollama");
      expect(cfg.baseUrl).toBe("https://ollama.com");
    });
  });

  it("does not set an Ollama base URL for local (no key)", () => {
    withEnv({ METALMIND_PROVIDER: "ollama" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.baseUrl).toBeUndefined();
    });
  });

  it("lets METALMIND_BASE_URL override the Ollama Cloud default", () => {
    withEnv({ METALMIND_PROVIDER: "ollama", OLLAMA_API_KEY: "sk-ollama", METALMIND_BASE_URL: "http://192.168.1.10:11434" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.baseUrl).toBe("http://192.168.1.10:11434");
    });
  });
});
