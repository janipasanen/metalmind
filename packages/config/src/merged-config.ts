import { loadXdgConfig, loadConfigFromFile, XDG_CONFIG_DIR, XDG_CONFIG_FILE } from "@metalmind/config";
import type { UserConfig } from "@metalmind/config";

/**
 * Merged config (#347): global user config (~/.config/metalmind/config.json) as
 * the base, with the project's metalmind.yaml layered on top where a section
 * has a direct equivalent:
 *   - ui.theme   → uiTheme (when it names light/dark/system)
 *   - mcp.<name> → mcpServers (project-defined stdio servers; enabled follows
 *                  autoConnect; a same-named global server wins)
 * models/routing are consumed directly by the router (createDefaultRouter);
 * permissions/tools are consumed by the agent (tool registry + approval gate).
 */
export function loadMergedConfig(directory: string = process.cwd()): UserConfig {
  const merged: UserConfig = { ...loadXdgConfig() };
  const project = loadConfigFromFile(directory);

  const theme = project.ui?.theme;
  if (theme === "light" || theme === "dark" || theme === "system") merged.uiTheme = theme;

  for (const [name, def] of Object.entries(project.mcp ?? {})) {
    if (merged.mcpServers[name]) continue; // global config wins on a name clash
    merged.mcpServers = {
      ...merged.mcpServers,
      [name]: {
        name,
        enabled: def.autoConnect ?? false,
        command: def.command,
        args: def.args,
        env: def.env,
        cwd: def.cwd,
      },
    };
  }

  return merged;
}

/**
 * Get global config dir and file paths
 */
export { XDG_CONFIG_DIR, XDG_CONFIG_FILE };
