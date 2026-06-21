import type { McpServerConfig } from "@metalmind/config";

/**
 * Curated MCP server presets (#192). Each preset is a one-line quick-add for a
 * common server — the user only supplies the secrets/paths it needs. Covers the
 * deployment targets: Filesystem, GitHub, GitLab, Atlassian Rovo (Jira +
 * Confluence), Database, and a generic FAQ server.
 *
 * Placeholders of the form {{key}} in args/url/env/headers are filled from the
 * user-supplied input values by {@link materializePreset}.
 */

export interface PresetInput {
  /** Key used both for the {{placeholder}} and the KEY=value argument. */
  key: string;
  label: string;
  /** Hide the value in echoes/logs (tokens, passwords). */
  secret?: boolean;
  /** When false the input may be omitted (a default or nothing is used). */
  required?: boolean;
  default?: string;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType?: "none" | "oauth2" | "bearer";
  /** OAuth endpoints for authType "oauth2"; values may contain {{placeholders}} (#224). */
  oauth?: { authEndpoint: string; tokenEndpoint: string; clientId: string; scope?: string };
  inputs: PresetInput[];
  docsUrl?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read/write files under a chosen root directory.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{{root}}"],
    inputs: [{ key: "root", label: "Root directory the server may access", required: true }],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests, repositories, code search.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{token}}" },
    inputs: [{ key: "token", label: "GitHub personal access token", secret: true, required: true }],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Projects, issues, merge requests, files.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    env: {
      GITLAB_PERSONAL_ACCESS_TOKEN: "{{token}}",
      GITLAB_API_URL: "{{apiUrl}}",
    },
    inputs: [
      { key: "token", label: "GitLab personal access token", secret: true, required: true },
      { key: "apiUrl", label: "GitLab API URL", required: false, default: "https://gitlab.com/api/v4" },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
  },
  {
    id: "atlassian",
    name: "Atlassian Rovo (Jira + Confluence)",
    description: "Atlassian's remote Rovo MCP server — Jira issues + Confluence pages (OAuth).",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/sse",
    authType: "oauth2",
    oauth: {
      authEndpoint: "https://auth.atlassian.com/authorize",
      tokenEndpoint: "https://auth.atlassian.com/oauth/token",
      clientId: "{{clientId}}",
      scope: "read:jira-work read:confluence-content.all offline_access",
    },
    inputs: [
      { key: "clientId", label: "Atlassian OAuth app client ID", required: true },
    ],
    docsUrl: "https://support.atlassian.com/rovo/docs/setting-up-ides/",
  },
  {
    id: "postgres",
    name: "Database — PostgreSQL",
    description: "Inspect schema and run read-only SQL queries.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{{connectionString}}"],
    inputs: [
      {
        key: "connectionString",
        label: "Postgres connection string (postgresql://user:pass@host:5432/db)",
        secret: true,
        required: true,
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
  },
  {
    id: "sqlite",
    name: "Database — SQLite",
    description: "Query a local SQLite database file.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "{{dbPath}}"],
    inputs: [{ key: "dbPath", label: "Path to the .sqlite/.db file", required: true }],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    id: "faq",
    name: "FAQ server",
    description: "A custom FAQ/knowledge MCP server reached over HTTP.",
    transport: "http",
    url: "{{url}}",
    headers: { Authorization: "Bearer {{token}}" },
    inputs: [
      { key: "url", label: "FAQ MCP server URL", required: true },
      { key: "token", label: "Bearer token (leave blank if none)", secret: true, required: false },
    ],
    docsUrl: "",
  },
];

export function findPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id.toLowerCase());
}

/** Replace every {{key}} occurrence in a string from the values map. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => values[key] ?? "");
}

export interface MaterializeResult {
  config: McpServerConfig;
  /** Required inputs the caller didn't supply. */
  missing: string[];
}

/**
 * Turn a preset + supplied input values into a concrete {@link McpServerConfig}.
 * Inputs left blank fall back to their `default`. Required inputs with no value
 * (and no default) are reported in `missing` and dropped from the output so a
 * half-configured server isn't silently created.
 */
export function materializePreset(preset: McpPreset, supplied: Record<string, string>): MaterializeResult {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const input of preset.inputs) {
    const raw = supplied[input.key]?.trim();
    const value = raw && raw.length > 0 ? raw : input.default ?? "";
    if (!value && input.required) missing.push(input.key);
    values[input.key] = value;
  }

  const base: McpServerConfig = { name: preset.name, enabled: true };
  if (preset.authType) base.authType = preset.authType;

  if (preset.transport === "stdio") {
    base.command = preset.command;
    base.args = (preset.args ?? []).map((a) => fill(a, values));
    if (preset.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(preset.env)) {
        const filled = fill(v, values);
        if (filled) env[k] = filled; // omit empty optional env vars
      }
      if (Object.keys(env).length > 0) base.env = env;
    }
  } else {
    base.url = fill(preset.url ?? "", values);
    if (preset.headers) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(preset.headers)) {
        const filled = fill(v, values);
        // Drop a header that still contains an unfilled placeholder (e.g. blank token).
        if (filled && !/\{\{|\bBearer\s*$/.test(filled)) headers[k] = filled;
      }
      if (Object.keys(headers).length > 0) base.headers = headers;
    }
  }

  // Emit OAuth endpoints so /mcp auth has what it needs (#224).
  if (preset.oauth) {
    base.oauth = {
      authEndpoint: fill(preset.oauth.authEndpoint, values),
      tokenEndpoint: fill(preset.oauth.tokenEndpoint, values),
      clientId: fill(preset.oauth.clientId, values),
      ...(preset.oauth.scope ? { scope: fill(preset.oauth.scope, values) } : {}),
    };
  }

  return { config: base, missing };
}

/** Parse `KEY=value` CLI-style pairs (values may contain `=`). */
export function parseKeyValues(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
