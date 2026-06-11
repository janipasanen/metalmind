import { OllamaProvider } from "@metalmind/providers";

/**
 * `/models` command (#203): manage local Ollama models from the TUI — list,
 * pull (with progress), and delete — instead of dropping to a shell. Always
 * targets the local daemon (127.0.0.1:11434), since model management is local.
 */

const LOCAL_OLLAMA = "http://127.0.0.1:11434";

function localProvider(): OllamaProvider {
  return new OllamaProvider("", LOCAL_OLLAMA);
}

function humanSize(bytes: number): string {
  if (!bytes) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export async function listModelsText(): Promise<string> {
  try {
    const models = await localProvider().listModelsDetailed();
    if (models.length === 0) return "No local Ollama models installed. Pull one with `/models pull <name>`.";
    const rows = models
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => `  ${m.name.padEnd(28)} ${humanSize(m.size).padStart(8)}`);
    return [`Local Ollama models (${models.length}):`, ...rows].join("\n");
  } catch (err) {
    return `Couldn't reach the local Ollama daemon at ${LOCAL_OLLAMA}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function deleteModelText(name: string): Promise<string> {
  if (!name) return "Usage: /models delete <name>";
  try {
    await localProvider().deleteModel(name);
    return `Deleted local model "${name}".`;
  } catch (err) {
    return `Couldn't delete "${name}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Yields human-readable progress lines while pulling a model. */
export async function* pullModelProgress(name: string): AsyncGenerator<string> {
  if (!name) {
    yield "Usage: /models pull <name>  (e.g. /models pull ministral-3:3b)";
    return;
  }
  yield `Pulling "${name}" from the Ollama registry…`;
  let lastPct = -1;
  try {
    for await (const ev of localProvider().pullModel(name)) {
      if (ev.total && ev.completed) {
        const pct = Math.floor((ev.completed / ev.total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          yield `  ${ev.status}: ${pct}% (${humanSize(ev.completed)}/${humanSize(ev.total)})`;
        }
      } else if (ev.status && ev.status !== "success") {
        yield `  ${ev.status}`;
      }
    }
    yield `Done — "${name}" is now available locally.`;
  } catch (err) {
    yield `Pull failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
