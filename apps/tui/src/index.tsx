import { render } from "ink";
import React from "react";
import App from "./components/App.js";
import { resolveConfig } from "./config.js";

const config = resolveConfig();
render(React.createElement(App, { config }));
