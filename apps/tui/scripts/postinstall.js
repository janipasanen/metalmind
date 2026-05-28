#!/usr/bin/env node
/**
 * Runs after `npm install`. On Apple Silicon, creates a Python venv and installs
 * the MLX sidecar dependencies (mlx-lm, fastapi, uvicorn) so local GPU inference
 * works without any manual setup.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";

if (!isAppleSilicon) {
  // Nothing to do on non-Apple-Silicon machines.
  process.exit(0);
}

const dataDir = join(homedir(), ".local", "share", "metalmind");
const venvDir = join(dataDir, "venv");
const pip = join(venvDir, "bin", "pip");

try {
  if (!existsSync(venvDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log("metalmind: setting up Python venv for MLX GPU inference...");
    execFileSync("python3", ["-m", "venv", venvDir], { stdio: "inherit" });
  }

  console.log("metalmind: installing MLX dependencies (mlx-lm, fastapi, uvicorn)...");
  execFileSync(pip, ["install", "--quiet", "--upgrade", "mlx-lm", "fastapi", "uvicorn"], {
    stdio: "inherit",
  });

  console.log("metalmind: MLX sidecar ready — Apple Silicon GPU will be used for local inference.");
} catch (err) {
  // Non-fatal: fall back to Ollama/cloud at runtime.
  console.warn("metalmind: MLX setup skipped —", err.message);
  console.warn("  To set up manually: pip install mlx-lm fastapi uvicorn");
}
