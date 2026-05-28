#!/usr/bin/env node
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve tsx/esm relative to this script, not CWD.
// Without pathToFileURL, Node resolves bare "tsx/esm" from CWD and crashes
// when metalmind is run from any directory that doesn't have tsx installed.
const tsxEsmPath = require.resolve("tsx/esm");
const entry = resolve(__dirname, "../src/index.tsx");

const { spawnSync } = require("child_process");

const result = spawnSync(
  process.execPath,
  ["--import", pathToFileURL(tsxEsmPath).href, entry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
  },
);

process.exit(result.status ?? 1);
