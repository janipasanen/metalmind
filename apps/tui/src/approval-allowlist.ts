import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";

/**
 * Persistent, granular approval allowlist (#220). Lets the user pre-approve
 * specific tools, file-path globs, or command prefixes so trusted operations
 * stop re-prompting — across sessions, unlike the session-scoped "always allow".
 */

export interface Allowlist {
  tools?: string[];
  paths?: string[];
  commands?: string[];
}

const FILE_OP_TOOLS = new Set(["writeFile", "createFile", "editFile", "deleteFile", "moveFile", "multiEdit"]);
const COMMAND_TOOLS = new Set(["runCommand", "runBackground"]);

/** Convert a simple glob (supporting ** and *) to a RegExp anchored at both ends. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash after **
      } else {
        re += "[^/]*";
      }
    } else if ("/.+?()[]{}^$|\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a (toolName, input) is pre-approved by the persisted allowlist. */
export function isAllowlisted(allowlist: Allowlist | undefined, toolName: string, input: Record<string, unknown>): boolean {
  if (!allowlist) return false;
  if (allowlist.tools?.includes(toolName)) return true;

  if (FILE_OP_TOOLS.has(toolName) && allowlist.paths?.length) {
    const path = typeof input.path === "string" ? input.path : typeof input.destination === "string" ? input.destination : "";
    const norm = path.replace(/^\.\//, "");
    if (path && allowlist.paths.some((g) => globToRegExp(g).test(norm))) return true;
  }

  if (COMMAND_TOOLS.has(toolName) && allowlist.commands?.length) {
    const cmd = typeof input.command === "string" ? input.command.trim() : "";
    if (cmd && allowlist.commands.some((p) => cmd.startsWith(p))) return true;
  }

  return false;
}

/** Handle the /allow command. */
export function handleAllowCommand(rawArgs: string): string {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "list").toLowerCase();
  const value = parts.slice(1).join(" ");
  const cfg = loadXdgConfig();
  const list: Allowlist = { ...(cfg.approvalAllowlist ?? {}) };

  const addTo = (key: "tools" | "paths" | "commands"): string => {
    if (!value) return `Usage: /allow ${sub} <value>`;
    const arr = Array.from(new Set([...(list[key] ?? []), value]));
    list[key] = arr;
    saveXdgConfig({ ...cfg, approvalAllowlist: list });
    return `Allowlisted ${sub.slice(0, -1) || sub} "${value}". It will auto-approve without prompting.`;
  };

  switch (sub) {
    case "tool": return addTo("tools");
    case "path": return addTo("paths");
    case "command": return addTo("commands");
    case "clear":
      saveXdgConfig({ ...cfg, approvalAllowlist: {} });
      return "Approval allowlist cleared.";
    case "list":
    default: {
      const t = list.tools ?? [], p = list.paths ?? [], c = list.commands ?? [];
      if (!t.length && !p.length && !c.length) {
        return "Approval allowlist is empty. Add entries: /allow tool <name> | path <glob> | command <prefix>.";
      }
      return [
        "Approval allowlist (auto-approved without prompting):",
        t.length ? `  tools:    ${t.join(", ")}` : "",
        p.length ? `  paths:    ${p.join(", ")}` : "",
        c.length ? `  commands: ${c.join(", ")}` : "",
      ].filter(Boolean).join("\n");
    }
  }
}
