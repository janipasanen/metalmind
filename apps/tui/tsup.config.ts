import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  target: "node18",
  clean: true,
  bundle: true,
  // tree-sitter uses N-API native addons and cannot be bundled.
  // All other dependencies (@metalmind/*, ink, react, zod …) are inlined
  // so the published package has no workspace/private deps.
  external: ["tree-sitter", "tree-sitter-typescript", "react-devtools-core"],
  esbuildOptions(options) {
    options.jsx = "automatic";
    // Inject a `require()` polyfill so CJS packages bundled into ESM can still
    // call require() for Node built-ins (e.g. signal-exit calls require("assert")).
    options.banner = {
      js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
    };
  },
});
