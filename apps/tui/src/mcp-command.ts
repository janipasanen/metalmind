import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";
import { MCP_PRESETS, findPreset, materializePreset, parseKeyValues } from "./mcp-presets.js";

/**
 * Handle the `/mcp` slash command (#192): a scriptable front-end to the MCP
 * preset catalog. Returns the message to show the user.
 *
 *   /mcp                       list configured servers
 *   /mcp presets               list available presets
 *   /mcp add <preset> k=v …    add a server from a preset
 *   /mcp remove <id>           remove a configured server
 *   /mcp enable|disable <id>   toggle a server without removing it
 */
export function handleMcpCommand(rawArgs: string): string {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "list").toLowerCase();
  const rest = parts.slice(1);

  switch (sub) {
    case "list":
    case "ls":
      return listServers();
    case "presets":
      return listPresets();
    case "add":
      return addServer(rest);
    case "remove":
    case "rm":
      return removeServer(rest[0]);
    case "enable":
      return setEnabled(rest[0], true);
    case "disable":
      return setEnabled(rest[0], false);
    default:
      return `Unknown /mcp subcommand "${sub}". Try: list | presets | add <preset> key=value | remove <id> | enable|disable <id>`;
  }
}

function listPresets(): string {
  const lines = MCP_PRESETS.map((p) => `  ${p.id.padEnd(12)} ${p.name} — ${p.description}`);
  return ["Available MCP presets (add with `/mcp add <id> key=value`):", ...lines].join("\n");
}

function listServers(): string {
  const cfg = loadXdgConfig();
  const entries = Object.entries(cfg.mcpServers ?? {});
  if (entries.length === 0) {
    return "No MCP servers configured. See `/mcp presets`, then `/mcp add <preset>`.";
  }
  const lines = entries.map(([id, s]) => {
    const dot = s.enabled ? "●" : "○";
    const where = s.url
      ? maskUrl(s.url)
      : `${s.command ?? ""} ${(s.args ?? []).map(maskSecretish).join(" ")}`.trim();
    return `  ${dot} ${id} — ${where}`;
  });
  return ["Configured MCP servers (● enabled, ○ disabled):", ...lines].join("\n");
}

function addServer(rest: string[]): string {
  const id = rest[0];
  if (!id) return `Usage: /mcp add <preset> key=value …   (see /mcp presets)`;
  const preset = findPreset(id);
  if (!preset) {
    return `No preset "${id}". Available: ${MCP_PRESETS.map((p) => p.id).join(", ")}`;
  }

  const argTokens = rest.slice(1);
  const values = parseKeyValues(argTokens);
  // Positional fallback: `/mcp add filesystem /path` fills the lone required input.
  const positionals = argTokens.filter((t) => !t.includes("="));
  const required = preset.inputs.filter((i) => i.required);
  if (positionals.length === 1 && required.length === 1 && !values[required[0].key]) {
    values[required[0].key] = positionals[0];
  }

  const { config, missing } = materializePreset(preset, values);
  if (missing.length > 0) {
    const labels = missing.map((k) => {
      const inp = preset.inputs.find((i) => i.key === k);
      return `${k} (${inp?.label ?? ""})`;
    });
    const usage = preset.inputs.map((i) => `${i.key}=…`).join(" ");
    return `Missing required input(s) for "${preset.id}": ${labels.join("; ")}.\nUsage: /mcp add ${preset.id} ${usage}`;
  }

  const cfg = loadXdgConfig();
  saveXdgConfig({ ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), [preset.id]: config } });

  const oauth = preset.authType === "oauth2" ? " You'll be asked to authorize (OAuth) on first connect." : "";
  return `Added MCP server "${preset.id}" — ${config.url ? maskUrl(config.url) : config.command}.${oauth}\nReconnect (reopen the MCP panel) or restart to load its tools.`;
}

function removeServer(id: string | undefined): string {
  if (!id) return "Usage: /mcp remove <id>";
  const cfg = loadXdgConfig();
  const servers = { ...(cfg.mcpServers ?? {}) };
  if (!servers[id]) return `No MCP server "${id}" configured.`;
  delete servers[id];
  saveXdgConfig({ ...cfg, mcpServers: servers });
  return `Removed MCP server "${id}".`;
}

function setEnabled(id: string | undefined, enabled: boolean): string {
  if (!id) return `Usage: /mcp ${enabled ? "enable" : "disable"} <id>`;
  const cfg = loadXdgConfig();
  const servers = { ...(cfg.mcpServers ?? {}) };
  if (!servers[id]) return `No MCP server "${id}" configured.`;
  servers[id] = { ...servers[id], enabled };
  saveXdgConfig({ ...cfg, mcpServers: servers });
  return `MCP server "${id}" ${enabled ? "enabled" : "disabled"}.`;
}

/** Mask credentials inside a connection string / token-bearing arg. */
function maskSecretish(s: string): string {
  if (/:\/\/[^/\s]*:[^/\s]*@/.test(s)) {
    return s.replace(/(:\/\/[^:/\s]+:)[^@/\s]+(@)/, "$1***$2");
  }
  if (/^[A-Za-z0-9_-]{24,}$/.test(s)) return `${s.slice(0, 4)}…`;
  return s;
}

/** Strip embedded credentials from a URL for display. */
function maskUrl(url: string): string {
  return url.replace(/(:\/\/[^:/\s]+:)[^@/\s]+(@)/, "$1***$2");
}
