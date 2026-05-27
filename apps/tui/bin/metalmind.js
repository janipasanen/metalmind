#!/usr/bin/env node
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsxBin = resolve(__dirname, "../node_modules/.bin/tsx");
const entry = resolve(__dirname, "../src/index.tsx");

const { spawnSync } = createRequire(import.meta.url)("child_process");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", entry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
  },
);

process.exit(result.status ?? 1);
