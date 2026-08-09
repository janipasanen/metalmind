import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredModel {
  /** What to show in a picker. */
  label: string;
  /** What to hand the provider — a path for LM Studio, a repo id for the HF cache. */
  model: string;
  source: "lmstudio" | "huggingface" | "ollama";
}

const LMSTUDIO_ROOT = join(homedir(), ".lmstudio", "models");
const HF_HUB = join(homedir(), ".cache", "huggingface", "hub");

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** An MLX model directory holds a config.json plus .safetensors weights.
 *  A GGUF download sitting in the same tree has neither, and mlx-lm cannot load
 *  it — listing one would offer a choice that always fails. */
function isMlxModelDir(dir: string): boolean {
  if (!existsSync(join(dir, "config.json"))) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

/** MLX models on this machine: LM Studio downloads and the HuggingFace cache.
 *
 *  The tier-1 picker used to be a hardcoded two-entry list — one of which was an
 *  absolute path to a specific developer's LM Studio folder — so it could not
 *  offer a model you had just downloaded, and offered models you had not. */
export function discoverMlxModels(): DiscoveredModel[] {
  const found: DiscoveredModel[] = [];

  // LM Studio: <root>/<publisher>/<model>/
  for (const publisher of safeReaddir(LMSTUDIO_ROOT)) {
    const publisherDir = join(LMSTUDIO_ROOT, publisher);
    for (const name of safeReaddir(publisherDir)) {
      const dir = join(publisherDir, name);
      if (!isMlxModelDir(dir)) continue;
      found.push({ label: `${name}  (MLX, LM Studio)`, model: dir, source: "lmstudio" });
    }
  }

  // HuggingFace cache: models--<org>--<name>. Only MLX conversions are usable
  // by the sidecar, and they are named as such by convention.
  for (const entry of safeReaddir(HF_HUB)) {
    if (!entry.startsWith("models--")) continue;
    const repo = entry.slice("models--".length).split("--").join("/");
    if (!/mlx|4bit|8bit|6bit|bf16/i.test(repo)) continue;
    found.push({ label: `${repo}  (MLX, HuggingFace)`, model: repo, source: "huggingface" });
  }

  return found.sort((a, b) => a.label.localeCompare(b.label));
}

/** Models installed in the local Ollama daemon. Empty when it is not running. */
export async function discoverOllamaModels(
  baseUrl = "http://127.0.0.1:11434",
): Promise<DiscoveredModel[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: unknown; size?: unknown }> };
    return (body.models ?? [])
      .map((m) => m?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .map((name) => ({ label: `${name}  (Ollama)`, model: name, source: "ollama" as const }));
  } catch {
    return [];
  }
}
