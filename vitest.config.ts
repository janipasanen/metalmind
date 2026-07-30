import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    workspace: [
      "packages/*",
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
        },
      },
    ],
  },
});
