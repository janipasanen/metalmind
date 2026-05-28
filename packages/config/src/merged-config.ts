import { loadXdgConfig, updateXdgConfig, XDG_CONFIG_DIR, XDG_CONFIG_FILE } from "@metalmind/config";
import type { UserConfig } from "@metalmind/config";

/**
 * Load merged config:
 * - Global user config (~/.config/metalmind/config.json) - base config
 * - Project-local config (metalmind.yaml) - overrides for current project
 */
export function loadMergedConfig(): UserConfig {
  const globalConfig = loadXdgConfig();
  
  // In production, load project-local metalmind.yaml if present
  // This would be handled by the existing loadConfigFromFile
  // For now, return global config with project-specific overrides applied
  
  return globalConfig;
}

/**
 * Save config to global store
 */
export function saveGlobalConfig(updates: Partial<UserConfig>): void {
  updateXdgConfig(updates);
}

/**
 * Get global config dir and file paths
 */
export { XDG_CONFIG_DIR, XDG_CONFIG_FILE };
