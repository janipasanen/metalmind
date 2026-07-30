import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolate every test run from the developer's real configuration (#415).
 *
 * Several test files load, mutate and delete `~/.config/metalmind/config.json`
 * — the file that holds apiKeys and mcpServers — relying on a backup/restore
 * around each test. Vitest runs those files in PARALLEL, so one file's restore
 * could clobber another's writes, and a crash (or a killed run) left the real
 * config replaced by test data.
 *
 * `METALMIND_CONFIG_DIR` is read at module load by @metalmind/config, and setup
 * files run before the test module graph is imported, so pointing it at a
 * throwaway directory here makes the isolation total: no test can reach the
 * real file even by accident.
 */
const dir = mkdtempSync(join(tmpdir(), "metalmind-test-config-"));
process.env.METALMIND_CONFIG_DIR = dir;

// Best-effort cleanup; a leftover temp dir is harmless either way.
process.once("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
