import { execSync } from "node:child_process";

export interface ShortcutDefinition {
  name: string;
  description: string;
  action: string; // URL scheme or command
  parameters?: Record<string, string>;
}

/**
 * macOS Shortcuts integration for exposing agent workflows.
 * Registers URL schemes and provides Shortcuts definitions.
 */
export class ShortcutsIntegration {
  private shortcuts: ShortcutDefinition[] = [];
  private baseUrlScheme = "metalmind://";

  /**
   * Register a workflow as an available Shortcut.
   */
  register(shortcut: ShortcutDefinition): void {
    this.shortcuts.push(shortcut);
  }

  /**
   * Get all registered shortcuts.
   */
  getShortcuts(): ShortcutDefinition[] {
    return [...this.shortcuts];
  }

  /**
   * Generate a .shortcut file for importing into Shortcuts app.
   */
  generateShortcutFile(
    shortcut: ShortcutDefinition,
  ): string {
    const params = shortcut.parameters
      ? Object.entries(shortcut.parameters)
          .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
          .join("")
      : "";

    const url = `${this.baseUrlScheme}${shortcut.action}${params}`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>WFWorkflowName</key>
    <string>${shortcut.name}</string>
    <key>WFWorkflowActions</key>
    <array>
        <dict>
            <key>WFWorkflowActionIdentifier</key>
            <string>is.workflow.actions.openurl</string>
            <key>WFWorkflowActionParameters</key>
            <dict>
                <key>WFURL</key>
                <string>${url}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;
  }

  /**
   * Register built-in Shortcuts for common MetalMind operations.
   */
  registerBuiltins(projectPath: string): void {
    this.register({
      name: "Open MetalMind",
      description: "Launch MetalMind in the current project",
      action: "open",
      parameters: { path: projectPath },
    });

    this.register({
      name: "MetalMind — Run Tests",
      description: "Run the project test suite",
      action: "run-tests",
      parameters: { path: projectPath },
    });

    this.register({
      name: "MetalMind — Git Status",
      description: "Show git status of the project",
      action: "git-status",
      parameters: { path: projectPath },
    });

    this.register({
      name: "MetalMind — Find Symbol",
      description: "Search for a symbol in the codebase",
      action: "find-symbol",
      parameters: { path: projectPath, query: "$query" },
    });
  }

  /**
   * Export all shortcuts as .shortcut files to a directory.
   */
  exportAll(outputDir: string): string[] {
    const { writeFileSync, mkdirSync, existsSync } = require("node:fs");
    const { join } = require("node:path");

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const files: string[] = [];
    for (const shortcut of this.shortcuts) {
      const filename = `${shortcut.name.replace(/\s+/g, "-").toLowerCase()}.shortcut`;
      const filepath = join(outputDir, filename);
      writeFileSync(filepath, this.generateShortcutFile(shortcut));
      files.push(filepath);
    }

    return files;
  }
}
