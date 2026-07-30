import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { XDG_CONFIG_DIR } from "@metalmind/config";
import { homedir } from "node:os";

/**
 * User-defined slash commands: markdown prompt templates on disk.
 *
 *   ~/.config/metalmind/commands/<name>.md   (global)
 *   <project>/.metalmind/commands/<name>.md  (project — overrides global)
 *
 * Typing /<name> [args] runs the file's content as the prompt for a normal
 * agent turn. `$ARGUMENTS` in the template is replaced with the args; without
 * the placeholder, args are appended. The first line (sans leading #) is the
 * description shown in autocomplete.
 */
export interface UserCommand {
  name: string;
  template: string;
  description: string;
}

export function userCommandDirs(projectRoot: string): string[] {
  return [join(XDG_CONFIG_DIR, "commands"), join(projectRoot, ".metalmind", "commands")];
}

export function loadUserCommands(projectRoot: string): UserCommand[] {
  const byName = new Map<string, UserCommand>();
  for (const dir of userCommandDirs(projectRoot)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue; // dir absent — fine
    }
    for (const f of entries.slice(0, 50)) {
      try {
        const template = readFileSync(join(dir, f), "utf-8").trim();
        if (!template) continue;
        const name = f.slice(0, -3);
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
        const description = (template.split("\n")[0] ?? "").replace(/^#\s*/, "").slice(0, 60) || "user command";
        byName.set(name, { name, template, description });
      } catch {
        // unreadable file — skip
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitute $ARGUMENTS (or append the args) to build the prompt. */
export function expandUserCommand(cmd: UserCommand, args: string): string {
  if (cmd.template.includes("$ARGUMENTS")) return cmd.template.replaceAll("$ARGUMENTS", args);
  return args ? `${cmd.template}\n\n${args}` : cmd.template;
}
