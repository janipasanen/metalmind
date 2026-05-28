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

/** Returns true if something is listening on the given port (400ms timeout). */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, 400);
  });
}

/**
 * Find the python3 binary that has mlx_lm installed.
 * Prefers the private venv created by postinstall; falls back to system
 * python3 when the user installed mlx-lm directly (no venv).
 */
function findMlxPython() {
  const venvPy = join(homedir(), ".local", "share", "metalmind", "venv", "bin", "python3");
  if (existsSync(venvPy)) return venvPy;

  // Check system python3 — covers manual `pip3 install mlx-lm` installs.
  const check = spawnSync("python3", ["-c", "import mlx_lm"], { stdio: "pipe" });
  if (check.status === 0) return "python3";

  return null;
}

// On Apple Silicon, ensure the MLX sidecar is running for GPU-local inference.
if (process.platform === "darwin" && process.arch === "arm64") {
  const already = await portOpen(8742);
  if (!already) {
    const python = findMlxPython();
    const sidecar = resolve(__dirname, "../../../scripts/mlx-sidecar.py");
    if (python && existsSync(sidecar)) {
      spawn(python, [sidecar], {
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
