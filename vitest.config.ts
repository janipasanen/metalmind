import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const SETUP = fileURLToPath(new URL("./vitest.setup.ts", import.meta.url));
const PACKAGES_DIR = fileURLToPath(new URL("./packages", import.meta.url));

/**
 * One project per workspace package, declared explicitly.
 *
 * A bare "packages/*" glob does NOT inherit the root `test` options: Vitest
 * builds each matched directory into its own project from that directory's own
 * config, and these packages have none. So `setupFiles` never ran for them and
 * METALMIND_CONFIG_DIR stayed unset — meaning @metalmind/config resolved
 * XDG_CONFIG_DIR to the developer's REAL ~/.config/metalmind. A test that wrote
 * or deleted a file there hit the real one (#415 was supposed to make that
 * impossible, and did for apps/tui only, which passes setupFiles explicitly).
 *
 * Enumerating the packages keeps each one a named project in the output while
 * guaranteeing every project gets the isolation setup.
 */
const packageProjects = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, "package.json")))
  .map((entry) => ({
    extends: true as const,
    test: {
      name: `@metalmind/${entry.name}`,
      root: `./packages/${entry.name}`,
      setupFiles: [SETUP],
    },
  }));

export default defineConfig({
  test: {
    // Point every project at a throwaway config dir before any module loads,
    // so no test can touch the developer's real ~/.config/metalmind (#415).
    setupFiles: [SETUP],
    workspace: [
      ...packageProjects,
      {
        // apps/tui is declared explicitly (not via an "apps/*" glob) so its
        // tests are collected ONLY from src/. tsc emits compiled copies of every
        // test into dist-tsc/ (kept separate from the published tsup bundle,
        // #402); a bare glob collected those too, running each test twice — once
        // from source and once from a stale build.
        extends: true,
        test: {
          name: "metalmind",
          root: "./apps/tui",
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          setupFiles: [SETUP],
        },
      },
    ],
  },
});
