import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node18",
  clean: true,
  bundle: true,
  // tree-sitter and better-sqlite3 use N-API native addons and cannot be
  // bundled — they stay as runtime deps. gpt-tokenizer is kept external too so
  // its large BPE tables aren't inlined into the startup bundle (lazy-loaded on
  // first exact token count, #212). All other dependencies (@metalmind/*, ink,
  // react, zod …) are inlined so the published package has no workspace deps.
  external: ["tree-sitter", "tree-sitter-typescript", "react-devtools-core", "better-sqlite3", "gpt-tokenizer"],
  esbuildOptions(options) {
    options.jsx = "automatic";
    // Inject a `require()` polyfill so CJS packages bundled into ESM can still
    // call require() for Node built-ins (e.g. signal-exit calls require("assert")).
    options.banner = {
      js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
    };
  },
});
