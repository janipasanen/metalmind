import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadConfigFromFile, validateConfig, CONFIG_FILE } from "./index.js";

describe("loadConfig", () => {
  it("returns defaults for empty input", () => {
    const cfg = loadConfig(null);
    expect(cfg.models).toEqual({});
  });

  it("returns defaults for invalid input", () => {
    const cfg = loadConfig({ models: "not-an-object" });
    expect(cfg.models).toEqual({});
  });

  it("parses valid config", () => {
    const cfg = loadConfig({
      models: { local: { provider: "ollama", model: "test" } },
    });
    expect(cfg.models.local?.provider).toBe("ollama");
  });
});

describe("loadConfigFromFile", () => {
  const testDir = join(tmpdir(), `metalmind-config-test-${Date.now()}`);

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  it("loads config from YAML file", () => {
    const yaml = `models:
  local:
    provider: ollama
    model: deepseek-coder:1.3b
routing:
  defaultLocalModel: local
  defaultReasoningModel: local
permissions:
  allowReadFiles: true
  allowWriteFiles: ask
`;
    writeFileSync(join(testDir, CONFIG_FILE), yaml);

    const cfg = loadConfigFromFile(testDir);
    expect(cfg.models.local?.provider).toBe("ollama");
    expect(cfg.models.local?.model).toBe("deepseek-coder:1.3b");
    expect(cfg.routing?.defaultLocalModel).toBe("local");
    expect(cfg.permissions?.allowReadFiles).toBe(true);
    expect(cfg.permissions?.allowWriteFiles).toBe("ask");
  });

  it("returns defaults when no config file exists", () => {
    const cfg = loadConfigFromFile(testDir);
    expect(cfg.models).toEqual({});
  });

  it("handles invalid YAML gracefully", () => {
    writeFileSync(join(testDir, CONFIG_FILE), "{{{ invalid: yaml: [[[");

    const cfg = loadConfigFromFile(testDir);
    expect(cfg.models).toEqual({});
  });

  it("walks up directory tree to find config", () => {
    const subDir = join(testDir, "a", "b", "c");
    mkdirSync(subDir, { recursive: true });

    const yaml = `models:
  deep:
    provider: ollama
    model: nested-model
`;
    writeFileSync(join(testDir, CONFIG_FILE), yaml);

    const cfg = loadConfigFromFile(subDir);
    expect(cfg.models.deep?.model).toBe("nested-model");
  });

  it("loads cloud provider config with api keys", () => {
    const yaml = `models:
  cloud:
    provider: anthropic
    model: claude-sonnet-latest
    apiKey: sk-test-key
`;
    writeFileSync(join(testDir, CONFIG_FILE), yaml);

    const cfg = loadConfigFromFile(testDir);
    expect(cfg.models.cloud?.apiKey).toBe("sk-test-key");
  });
});

describe("validateConfig", () => {
  it("returns success for valid config", () => {
    const result = validateConfig({
      models: { local: { provider: "ollama", model: "test" } },
    });
    expect(result.success).toBe(true);
    expect(result.config).toBeDefined();
  });

  it("returns errors for invalid config", () => {
    const result = validateConfig({
      models: { local: { provider: "ollama" } },
    });
    expect(result.success).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects config with missing models", () => {
    const result = validateConfig({});
    expect(result.success).toBe(false);
  });
});
