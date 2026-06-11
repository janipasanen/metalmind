import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { XDG_CONFIG_FILE, loadXdgConfig } from "@metalmind/config";
import {
  MCP_PRESETS,
  findPreset,
  materializePreset,
  parseKeyValues,
} from "../mcp-presets.js";
import { handleMcpCommand } from "../mcp-command.js";

describe("MCP preset catalog (#192)", () => {
  it("includes the deployment-target servers", () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    for (const id of ["filesystem", "github", "gitlab", "atlassian", "postgres", "faq"]) {
      expect(ids).toContain(id);
    }
  });

  it("materializes a stdio preset, filling {{placeholders}} into args/env", () => {
    const { config, missing } = materializePreset(findPreset("github")!, { token: "ghp_secret" });
    expect(missing).toEqual([]);
    expect(config.command).toBe("npx");
    expect(config.args).toContain("@modelcontextprotocol/server-github");
    expect(config.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" });
    expect(config.enabled).toBe(true);
  });

  it("substitutes a path argument for the filesystem preset", () => {
    const { config } = materializePreset(findPreset("filesystem")!, { root: "/Users/me/proj" });
    expect(config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/proj"]);
  });

  it("uses an input default when the value is omitted (gitlab apiUrl)", () => {
    const { config, missing } = materializePreset(findPreset("gitlab")!, { token: "glpat_x" });
    expect(missing).toEqual([]);
    expect(config.env?.GITLAB_API_URL).toBe("https://gitlab.com/api/v4");
    expect(config.env?.GITLAB_PERSONAL_ACCESS_TOKEN).toBe("glpat_x");
  });

  it("reports missing required inputs instead of producing a half-config", () => {
    const { missing } = materializePreset(findPreset("postgres")!, {});
    expect(missing).toContain("connectionString");
  });

  it("carries OAuth http presets through with authType + url", () => {
    const { config, missing } = materializePreset(findPreset("atlassian")!, {});
    expect(missing).toEqual([]);
    expect(config.url).toBe("https://mcp.atlassian.com/v1/sse");
    expect(config.authType).toBe("oauth2");
  });

  it("drops an empty optional bearer header (faq without token)", () => {
    const { config } = materializePreset(findPreset("faq")!, { url: "https://faq.example.com/mcp" });
    expect(config.url).toBe("https://faq.example.com/mcp");
    expect(config.headers).toBeUndefined();
  });

  it("parses KEY=value pairs including values containing '='", () => {
    expect(parseKeyValues(["token=ab=cd", "x=1"])).toEqual({ token: "ab=cd", x: "1" });
  });
});

describe("/mcp command (#192)", () => {
  // Snapshot/restore the real XDG config so these are non-destructive.
  let backup: string | null = null;
  beforeEach(() => {
    backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null;
  });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("lists available presets", () => {
    const out = handleMcpCommand("presets");
    expect(out).toContain("github");
    expect(out).toContain("Atlassian Rovo");
  });

  it("adds a server from a preset and persists it to config", () => {
    const out = handleMcpCommand("add github token=ghp_abc123");
    expect(out).toContain('Added MCP server "github"');
    const cfg = loadXdgConfig();
    expect(cfg.mcpServers?.github?.command).toBe("npx");
    expect(cfg.mcpServers?.github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_abc123");
  });

  it("accepts a positional value for a single-required-input preset", () => {
    handleMcpCommand("add filesystem /tmp/workdir");
    expect(loadXdgConfig().mcpServers?.filesystem?.args).toContain("/tmp/workdir");
  });

  it("refuses to add when a required input is missing", () => {
    const out = handleMcpCommand("add postgres");
    expect(out).toContain("Missing required input");
    expect(loadXdgConfig().mcpServers?.postgres).toBeUndefined();
  });

  it("enables, disables, and removes a configured server", () => {
    handleMcpCommand("add filesystem /tmp/x");
    expect(handleMcpCommand("disable filesystem")).toContain("disabled");
    expect(loadXdgConfig().mcpServers?.filesystem?.enabled).toBe(false);
    expect(handleMcpCommand("enable filesystem")).toContain("enabled");
    expect(handleMcpCommand("remove filesystem")).toContain("Removed");
    expect(loadXdgConfig().mcpServers?.filesystem).toBeUndefined();
  });

  it("masks credentials in a connection string when listing", () => {
    handleMcpCommand("add postgres connectionString=postgresql://user:supersecret@localhost:5432/db");
    const out = handleMcpCommand("list");
    expect(out).toContain("postgres");
    expect(out).not.toContain("supersecret");
  });
});
