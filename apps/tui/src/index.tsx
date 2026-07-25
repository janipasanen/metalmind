import { render } from "ink";
import React from "react";
import { killAllBackgroundProcesses } from "@metalmind/tools";
import App from "./components/App.js";
import { resolveConfig } from "./config.js";
import { logError } from "./error-log.js";

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

const config = resolveConfig();
render(React.createElement(App, { config }));
