import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  loadConfig,
  loadConfigFromFile,
  validateConfig,
  getConfigLoadIssue,
  CONFIG_FILE,
  GLOBAL_CONFIG_FILE,
  XDG_CONFIG_DIR,
} from "./index.js";

// A "packages/*" glob in the vitest workspace did not inherit the root
// setupFiles, so METALMIND_CONFIG_DIR stayed unset here and XDG_CONFIG_DIR
// resolved to the developer's REAL ~/.config/metalmind — a test writing or
// deleting a file there hit the real one. Guard the invariant directly.
describe("test isolation (#415)", () => {
  it("never resolves the config dir to the real home directory", () => {
    expect(process.env.METALMIND_CONFIG_DIR).toBeTruthy();
    expect(XDG_CONFIG_DIR).toBe(process.env.METALMIND_CONFIG_DIR);
    expect(XDG_CONFIG_DIR).not.toBe(join(homedir(), ".config", "metalmind"));
    expect(GLOBAL_CONFIG_FILE.startsWith(homedir() + "/.config/metalmind")).toBe(false);
  });
});

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

  it("accepts a config with no models section, defaulting it to {} (#383)", () => {
    // `models` used to be required, so a metalmind.yaml that only configured
    // permissions/tools/mcp failed validation and the WHOLE file was discarded.
    const result = validateConfig({});
    expect(result.success).toBe(true);
    expect(result.config?.models).toEqual({});
  });

  it("still rejects a config whose sections have the wrong shape", () => {
    expect(validateConfig({ tools: { shell: "yes" } }).success).toBe(false);
    expect(validateConfig({ models: { a: { provider: 1 } } }).success).toBe(false);
  });
});

// `metalmind` is installed once and run in any directory, but models/routing
// used to come only from a metalmind.yaml found by walking up from the cwd. Run
// it outside a configured project and every tier fell back to a built-in
// default — tier 2 as "ministral-3:3b" whether or not it was installed.
describe("loadConfigFromFile — user-level config", () => {
  const testRoot = join(tmpdir(), `metalmind-global-test-${process.pid}`);
  const projectDir = join(testRoot, "project");
  // Never the real GLOBAL_CONFIG_FILE: vitest runs files in parallel and that
  // path is now an input to every loadConfigFromFile call in the run, so
  // writing it here would intermittently break unrelated tests.
  const globalFile = join(testRoot, "global", CONFIG_FILE);

  const writeGlobal = (yaml: string) => {
    mkdirSync(dirname(globalFile), { recursive: true });
    writeFileSync(globalFile, yaml);
  };

  beforeEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("reads the user-level config from the config dir by default", () => {
    expect(GLOBAL_CONFIG_FILE).toBe(join(XDG_CONFIG_DIR, CONFIG_FILE));
  });

  it("applies the user-level config in a directory with no project config", () => {
    writeGlobal(`models:
  local-ollama:
    provider: ollama
    model: qwen3.5:4b-mlx
routing:
  defaultLocalModel: local-mlx
  defaultFallbackModel: local-ollama
  defaultReasoningModel: cloud-reasoning
`);
    const cfg = loadConfigFromFile(projectDir, { globalFile });
    expect(cfg.models["local-ollama"]?.model).toBe("qwen3.5:4b-mlx");
    expect(cfg.routing?.defaultFallbackModel).toBe("local-ollama");
  });

  it("lets a project config override a section it defines", () => {
    writeGlobal(`routing:
  defaultLocalModel: local-mlx
  defaultFallbackModel: global-tier
  defaultReasoningModel: cloud-reasoning
`);
    writeFileSync(
      join(projectDir, CONFIG_FILE),
      `routing:
  defaultLocalModel: local-mlx
  defaultFallbackModel: project-tier
  defaultReasoningModel: cloud-reasoning
`,
    );
    expect(loadConfigFromFile(projectDir, { globalFile }).routing?.defaultFallbackModel).toBe("project-tier");
  });

  it("merges models by name so a project adding one keeps the rest", () => {
    // `models` defaults to {} on every parse, so replacing the section
    // wholesale would erase the global registry from any project config that
    // never mentioned models.
    writeGlobal(`models:
  local-mlx:
    provider: mlx
    model: global-mlx
  local-ollama:
    provider: ollama
    model: global-ollama
`);
    writeFileSync(
      join(projectDir, CONFIG_FILE),
      `models:
  local-mlx:
    provider: mlx
    model: project-mlx
`,
    );
    const cfg = loadConfigFromFile(projectDir, { globalFile });
    expect(cfg.models["local-mlx"]?.model).toBe("project-mlx"); // project wins
    expect(cfg.models["local-ollama"]?.model).toBe("global-ollama"); // inherited
  });

  it("keeps the user-level config when a project config is unusable", () => {
    writeGlobal(`models:
  local-ollama:
    provider: ollama
    model: from-global
`);
    writeFileSync(join(projectDir, CONFIG_FILE), "models: [this is not a mapping\n");
    const cfg = loadConfigFromFile(projectDir, { globalFile });
    expect(cfg.models["local-ollama"]?.model).toBe("from-global");
    expect(getConfigLoadIssue()?.path).toBe(join(projectDir, CONFIG_FILE));
  });

  it("still returns defaults when neither config exists", () => {
    expect(loadConfigFromFile(projectDir, { globalFile }).models).toEqual({});
  });
});
