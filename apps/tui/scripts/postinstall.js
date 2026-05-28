#!/usr/bin/env node
/**
 * Runs after `npm install`. On Apple Silicon, installs the MLX sidecar
 * dependencies (mlx-lm, fastapi, uvicorn) into a .venv at the repo root
 * so local GPU inference works without any manual setup.
 *
 * If mlx-lm is already importable from the system Python (user installed
 * it manually), the .venv step is skipped.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const venvDir = join(repoRoot, ".venv");
const venvPython = join(venvDir, "bin", "python3");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  process.exit(0);
}

function findSystemPython() {
  for (const candidate of ["python3", "/usr/bin/python3"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function mlxImportable(python) {
  try {
    execFileSync(python, ["-c", "import mlx_lm"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const systemPy = findSystemPython();
if (!systemPy) {
  console.warn("metalmind: python3 not found — MLX GPU inference will be unavailable.");
  console.warn("  Install Python 3, then: python3 -m pip install mlx-lm fastapi uvicorn");
  process.exit(0);
}

try {
  if (!existsSync(venvPython)) {
    // mlx-lm already installed in system Python? No .venv needed.
    if (mlxImportable(systemPy)) {
      console.log("metalmind: mlx-lm already installed — skipping .venv setup.");
      process.exit(0);
    }

    console.log(`metalmind: creating .venv at ${venvDir} for MLX GPU inference...`);
    execFileSync(systemPy, ["-m", "venv", venvDir], { stdio: "inherit" });
  }

  console.log("metalmind: installing MLX dependencies (mlx-lm, fastapi, uvicorn)...");
  execFileSync(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade",
    "mlx-lm", "fastapi", "uvicorn"], { stdio: "inherit" });

  console.log("metalmind: MLX ready — Apple Silicon GPU will be used for local inference.");
} catch (err) {
  console.warn("metalmind: MLX setup skipped —", err.message);
  console.warn("  To set up manually: python3 -m pip install mlx-lm fastapi uvicorn");
}
