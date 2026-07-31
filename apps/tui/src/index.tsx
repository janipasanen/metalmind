import { render } from "ink";
import React from "react";
import { killAllBackgroundProcesses } from "@metalmind/tools";
import App from "./components/App.js";
import { resolveConfig } from "./config.js";
import { logError } from "./error-log.js";

// --version smoke path (#351): prints and exits before any TTY setup. CI runs
// the BUILT bundle with this flag after tsup, so a bundle-only runtime failure
// (bad external, ESM/CJS interop, missing asset) fails the pipeline instead of
// publishing silently. Keep in sync with apps/tui/package.json.
const VERSION = "0.1.0";
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`metalmind ${VERSION}`);
  process.exit(0);
}

// Crash telemetry: persist uncaught failures so they survive the session (#217).
process.on("uncaughtException", (err) => logError("uncaughtException", err));
process.on("unhandledRejection", (reason) => logError("unhandledRejection", reason));

// Bracketed paste (#287): terminals only wrap pastes in ESC[200~/201~ markers —
// which multiline.ts already parses — when the app ENABLES the mode. Turn it on
// at startup and always restore the terminal on the way out.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
if (process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_ON);
const restoreTerminal = () => {
  if (process.stdout.isTTY) process.stdout.write(BRACKETED_PASTE_OFF);
};

// Backstop: never leave background processes (dev servers, watchers) orphaned
// when the TUI exits — including Ctrl+C / SIGINT (#153).
process.once("exit", () => {
  restoreTerminal();
  killAllBackgroundProcesses();
});
process.once("SIGINT", () => {
  restoreTerminal();
  killAllBackgroundProcesses();
  process.exit(0);
});
// SIGTERM (kill, service managers) and SIGHUP (terminal window closed) would
// otherwise terminate without running the 'exit' backstop's cleanup path
// reliably — same teardown, conventional 128+signum exit codes (#338).
process.once("SIGTERM", () => {
  restoreTerminal();
  killAllBackgroundProcesses();
  process.exit(143);
});
process.once("SIGHUP", () => {
  restoreTerminal();
  killAllBackgroundProcesses();
  process.exit(129);
});

// Startup must never die silently (#435/#436): resolveConfig touches the config
// directory (which can be unwritable or read-only) and normalizes a provider
// name that may not exist. Both used to throw BEFORE the first paint, and
// because Ink was not mounted yet the process exited with no output at all.
let config;
try {
  config = resolveConfig();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  logError("startup", err);
  process.stderr.write(
    `\nMetalMind could not start.\n\n  ${msg}\n\n` +
      `Common causes:\n` +
      `  • ~/.config/metalmind is not writable — fix permissions, or set\n` +
      `    METALMIND_CONFIG_DIR=/some/writable/dir\n` +
      `  • an unknown provider in config.json / --provider / METALMIND_PROVIDER\n` +
      `    (valid: ollama, ollama-cloud, anthropic, openai, mlx)\n\n`,
  );
  restoreTerminal();
  process.exit(1);
}
render(React.createElement(App, { config }));
