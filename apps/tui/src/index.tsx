import { render } from "ink";
import React from "react";
import { killAllBackgroundProcesses } from "@metalmind/tools";
import App from "./components/App.js";
import { resolveConfig } from "./config.js";

// Backstop: never leave background processes (dev servers, watchers) orphaned
// when the TUI exits — including Ctrl+C / SIGINT (#153).
process.once("exit", killAllBackgroundProcesses);
process.once("SIGINT", () => {
  killAllBackgroundProcesses();
  process.exit(0);
});

const config = resolveConfig();
render(React.createElement(App, { config }));
