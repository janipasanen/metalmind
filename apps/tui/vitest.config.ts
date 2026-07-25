import { defineConfig } from "vitest/config";

// Project-scoped config for the TUI package. The setup file isolates HOME per
// worker so the XDG-config-heavy TUI tests don't share (and race on) the real
// ~/.config/metalmind/config.json.
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
