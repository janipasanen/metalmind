#!/usr/bin/env node
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { spawn, spawnSync } from "child_process";
import { createConnection } from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Returns true if something is listening on the given port. */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    // Bail out quickly — we don't want to slow startup on a cold machine.
    setTimeout(() => { socket.destroy(); resolve(false); }, 400);
  });
}

// On Apple Silicon, ensure the MLX sidecar is running for GPU-local inference.
// The sidecar is a background process; we fire-and-forget and let the agent's
// health-check handle the case where it isn't ready yet on the first turn.
if (process.platform === "darwin" && process.arch === "arm64") {
  const already = await portOpen(8742);
  if (!already) {
    const venvPython = join(homedir(), ".local", "share", "metalmind", "venv", "bin", "python3");
    const sidecar = resolve(__dirname, "../../../scripts/mlx-sidecar.py");
    if (existsSync(venvPython) && existsSync(sidecar)) {
      spawn(venvPython, [sidecar], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      }).unref();
    }
  }
}

// Resolve tsx/esm relative to this script, not CWD, so `metalmind` works from any directory.
const tsxEsmPath = require.resolve("tsx/esm");
const entry = resolve(__dirname, "../src/index.tsx");

const result = spawnSync(
  process.execPath,
  ["--import", pathToFileURL(tsxEsmPath).href, entry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
  },
);

process.exit(result.status ?? 1);
