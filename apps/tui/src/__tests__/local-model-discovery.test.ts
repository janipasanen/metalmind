import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverOllamaModels } from "../local-model-discovery.js";

// The tier-1 picker was a hardcoded two-entry list — one entry an absolute path
// into a specific developer's LM Studio folder, pointing at a model that had
// since been deleted. It could not offer a model you had just downloaded.
describe("discoverMlxModels", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** Build a fake home with the given LM Studio model dirs, then import the
   *  module fresh so it reads that home. */
  async function withHome(
    build: (home: string) => void,
  ): Promise<Array<{ label: string; model: string }>> {
    const home = mkdtempSync(join(tmpdir(), "mm-home-"));
    roots.push(home);
    build(home);
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
    });
    const mod = await import("../local-model-discovery.js");
    return mod.discoverMlxModels();
  }

  const makeMlxModel = (home: string, publisher: string, name: string) => {
    const dir = join(home, ".lmstudio", "models", publisher, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "model-00001-of-00002.safetensors"), "");
  };

  it("finds an MLX model downloaded through LM Studio", async () => {
    const found = await withHome((home) =>
      makeMlxModel(home, "lmstudio-community", "Ornith-1.0-9B-MLX-4bit"),
    );
    expect(found).toHaveLength(1);
    expect(found[0].label).toContain("Ornith-1.0-9B-MLX-4bit");
    expect(found[0].model).toContain("/.lmstudio/models/lmstudio-community/Ornith-1.0-9B-MLX-4bit");
  });

  it("skips a GGUF download the sidecar could never load", async () => {
    const found = await withHome((home) => {
      const dir = join(home, ".lmstudio", "models", "someone", "a-gguf-model");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "model.gguf"), "");
    });
    expect(found).toEqual([]);
  });

  it("returns nothing rather than throwing when no models directory exists", async () => {
    const found = await withHome(() => {});
    expect(found).toEqual([]);
  });
});

describe("discoverOllamaModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists what the daemon reports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "qwen3.5:4b-mlx" }, { name: "deepseek-coder:1.3b" }] }),
      }),
    );
    const models = await discoverOllamaModels();
    expect(models.map((m) => m.model)).toEqual(["qwen3.5:4b-mlx", "deepseek-coder:1.3b"]);
  });

  it("returns an empty list when the daemon is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await discoverOllamaModels()).toEqual([]);
  });
});
