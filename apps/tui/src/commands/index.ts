import type { Command } from "../components/CommandPalette.js";

export const commands: Command[] = [
  {
    id: "provider",
    title: "Provider",
    description: "Select AI provider",
    action: () => {
      console.log("Provider selection not yet implemented");
    },
  },
  {
    id: "model",
    title: "Model",
    description: "Select a model",
    action: () => {
      console.log("Model selection not yet implemented");
    },
  },
  {
    id: "mcp",
    title: "MCP",
    description: "Configure MCP servers",
    action: () => {
      console.log("MCP configuration not yet implemented");
    },
  },
];
