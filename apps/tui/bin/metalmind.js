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
 *   1. ~/.local/share/metalmind/.venv  — created by postinstall
 *   2. system python3                  — covers manual pip installs
 */
function findMlxPython() {
  const venvPy = join(homedir(), ".local", "share", "metalmind", ".venv", "bin", "python3");
  // Existence is not enough (#403): a postinstall whose pip step failed leaves a
  // venv WITHOUT mlx_lm, and preferring it blindly disabled the MLX tier forever
  // even when a perfectly good system python was available. Verify it works.
  if (existsSync(venvPy)) {
    const ok = spawnSync(venvPy, ["-c", "import mlx_lm"], { stdio: "pipe" });
    if (ok.status === 0) return venvPy;
  }

  const check = spawnSync("python3", ["-c", "import mlx_lm"], { stdio: "pipe" });
  if (check.status === 0) return "python3";

  return null;
}

// On Apple Silicon, ensure the MLX sidecar is running for GPU-local inference.
if (process.platform === "darwin" && process.arch === "arm64") {
  const already = await portOpen(8742);
  if (!already) {
    const python = findMlxPython();
    const sidecar = resolve(__dirname, "../scripts/mlx-sidecar.py");
    if (python && existsSync(sidecar)) {
      // Pass --model so the sidecar starts loading the model in the background
      // immediately. The HTTP server starts right away; model_loaded becomes true
      // once the weights are in memory (a few seconds if cached, longer on first run).
      const defaultMlxModel = "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit";
      spawn(python, [sidecar, "--model", defaultMlxModel], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      }).unref();
    }
  }
}

// Prefer the compiled bundle (dist/index.js) — present in published packages and after `npm run build`.
// Fall back to tsx for local development from source (no build step required).
const distEntry = resolve(__dirname, "../dist/index.js");
const srcEntry = resolve(__dirname, "../src/index.tsx");

let result;
if (existsSync(distEntry)) {
  result = spawnSync(process.execPath, [distEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env },
  });
} else {
  // Dev mode: run TypeScript source directly via tsx.
  const tsxEsmPath = require.resolve("tsx/esm");
  result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(tsxEsmPath).href, srcEntry, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
    },
  );
}

process.exit(result.status ?? 1);
