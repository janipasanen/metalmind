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
    const cfg = resolveConfig(["--provider", "ollama"]);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("deepseek-coder:1.3b");
  });

  it("auto-detects anthropic from ANTHROPIC_API_KEY", () => {
    withEnv({ METALMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.provider).toBe("anthropic");
      expect(cfg.model).toBe("claude-sonnet-4-6");
      expect(cfg.apiKey).toBe("sk-ant-test");
    });
  });

  it("auto-detects openai from OPENAI_API_KEY when no anthropic key", () => {
    const cfg = resolveConfig(["--provider", "openai"]);
    withEnv({ OPENAI_API_KEY: "sk-openai-test" }, () => {
      const cfg2 = resolveConfig(["--provider", "openai"]);
      expect(cfg2.provider).toBe("openai");
      expect(cfg2.model).toBe("gpt-4o");
    });
  });

  it("anthropic takes priority over openai when both keys present", () => {
    withEnv({ METALMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }, () => {
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

  it("reads OLLAMA_API_KEY and defaults to ollama-cloud", () => {
    withEnv({ OLLAMA_API_KEY: "sk-ollama" }, () => {
      const cfg = resolveConfig(["--provider", "ollama-cloud", "--model", "gemini-3-flash-preview:cloud"]);
      expect(cfg.provider).toBe("ollama-cloud");
      expect(cfg.model).toBe("gemini-3-flash-preview:cloud");
      expect(cfg.baseUrl).toBe("https://api.ollama.com");
    });
  });

  it("does not set an Ollama base URL for local (no key)", () => {
    const cfg = resolveConfig(["--provider", "ollama"]);
    expect(cfg.model).toBe("deepseek-coder:1.3b");
  });

  it("lets METALMIND_BASE_URL override the Ollama Cloud default", () => {
    withEnv({ METALMIND_PROVIDER: "ollama", OLLAMA_API_KEY: "sk-ollama", METALMIND_BASE_URL: "http://192.168.1.10:11434" }, () => {
      const cfg = resolveConfig([]);
      expect(cfg.baseUrl).toBe("http://192.168.1.10:11434");
    });
  });
});

describe("resolveConfig with metalmind.yaml", () => {
  beforeEach(() => {
    delete process.env.METALMIND_PROVIDER;
    delete process.env.METALMIND_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.METALMIND_BASE_URL;
  });

  const fileConfig = {
    models: {
      localMlx: {
        provider: "mlx",
        model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
        baseUrl: "http://127.0.0.1:8742",
      },
      ollamaCloud: {
        provider: "ollama",
        model: "gemma3",
        baseUrl: "https://ollama.com",
        apiKey: "sk-from-yaml",
      },
    },
    routing: {
      defaultLocalModel: "localMlx",
      defaultReasoningModel: "ollamaCloud",
    },
  };

  it("resolves a named model via --model", () => {
    const cfg = resolveConfig(["--model", "ollamaCloud"], fileConfig);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("gemma3");
    expect(cfg.baseUrl).toBe("https://ollama.com");
    expect(cfg.apiKey).toBe("sk-from-yaml");
  });

  it("honours routing.defaultLocalModel when nothing is specified", () => {
    const cfg = resolveConfig([], fileConfig);
    expect(cfg.provider).toBe("mlx");
    expect(cfg.model).toBe("mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8742");
  });

  it("env var overrides the yaml default local model", () => {
    withEnv({ METALMIND_PROVIDER: "ollama", METALMIND_MODEL: "llama3" }, () => {
      const cfg = resolveConfig([], fileConfig);
      expect(cfg.provider).toBe("ollama");
      expect(cfg.model).toBe("llama3");
    });
  });

  it("CLI flag overrides env var which overrides yaml", () => {
    withEnv({ METALMIND_MODEL: "ollamaCloud" }, () => {
      const cfg = resolveConfig(["--model", "localMlx"], fileConfig);
      expect(cfg.provider).toBe("mlx");
      expect(cfg.model).toBe("mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit");
    });
  });

  it("env API key overrides a named entry's apiKey", () => {
    withEnv({ OLLAMA_API_KEY: "sk-from-env" }, () => {
      const cfg = resolveConfig(["--model", "ollamaCloud"], fileConfig);
      expect(cfg.apiKey).toBe("sk-from-env");
    });
  });

  it("METALMIND_BASE_URL overrides a named entry's baseUrl", () => {
    withEnv({ METALMIND_BASE_URL: "http://127.0.0.1:9000" }, () => {
      const cfg = resolveConfig(["--model", "localMlx"], fileConfig);
      expect(cfg.baseUrl).toBe("http://127.0.0.1:9000");
    });
  });

  it("falls back to built-in defaults when the model name is not a yaml entry", () => {
    const cfg = resolveConfig(["--provider", "ollama", "--model", "mistral"], fileConfig);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.model).toBe("mistral");
  });

  it("does not apply the yaml default local model when a provider is explicitly chosen", () => {
    const cfg = resolveConfig(["--provider", "anthropic"], fileConfig);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });
});

import { resolveApiKey } from "../config.js";

describe("resolveApiKey precedence — env beats config (#auth)", () => {
  it("a non-empty env var overrides the stored config key", () => {
    withEnv({ OLLAMA_API_KEY: "env-key" }, () => {
      expect(resolveApiKey("ollama-cloud", "stale-config-key")).toBe("env-key");
      expect(resolveApiKey("ollama", "stale-config-key")).toBe("env-key");
    });
  });

  it("an empty env var falls back to the config key (doesn't blank it out)", () => {
    withEnv({ OLLAMA_API_KEY: "" }, () => {
      expect(resolveApiKey("ollama-cloud", "config-key")).toBe("config-key");
    });
  });

  it("an unset env var uses the config key", () => {
    withEnv({ OLLAMA_API_KEY: undefined }, () => {
      expect(resolveApiKey("ollama-cloud", "config-key")).toBe("config-key");
    });
  });

  it("returns undefined when neither is present", () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(resolveApiKey("anthropic", undefined)).toBeUndefined();
      expect(resolveApiKey("anthropic", "")).toBeUndefined();
    });
  });

  it("works for each provider's env var", () => {
    withEnv({ ANTHROPIC_API_KEY: "ak", OPENAI_API_KEY: "ok" }, () => {
      expect(resolveApiKey("anthropic", "cfg")).toBe("ak");
      expect(resolveApiKey("openai", "cfg")).toBe("ok");
    });
  });
});

import { providerCredentials } from "../config.js";

describe("METALMIND_BASE_URL is not applied to other providers (#234)", () => {
  it("a non-active provider uses its own default, not the global override", () => {
    withEnv({ METALMIND_BASE_URL: "http://192.168.1.10:11434" }, () => {
      // anthropic's base URL must NOT become the Ollama host the user set
      expect(providerCredentials("anthropic").baseUrl).not.toBe("http://192.168.1.10:11434");
      // ollama-cloud uses its own default
      expect(providerCredentials("ollama-cloud").baseUrl).toBe("https://api.ollama.com");
    });
  });
});
