import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfigFromFile, getConfigLoadIssue } from "@metalmind/config";

describe("metalmind.yaml without `models` (#383)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mm-yaml-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps permissions/tools/mcp when the file has no models section", () => {
    writeFileSync(
      join(dir, "metalmind.yaml"),
      [
        "permissions:",
        "  allowShellCommands: true",
        "tools:",
        "  shell: false",
        "mcp:",
        "  local-thing:",
        "    command: echo",
        "    autoConnect: true",
      ].join("\n"),
    );
    const cfg = loadConfigFromFile(dir);
    expect(getConfigLoadIssue()).toBeNull();
    expect(cfg.permissions?.allowShellCommands).toBe(true);
    expect(cfg.tools?.shell).toBe(false);
    expect(cfg.mcp?.["local-thing"]?.command).toBe("echo");
    expect(cfg.models).toEqual({});
  });

  it("reports WHY a malformed file was discarded instead of failing silently", () => {
    writeFileSync(join(dir, "metalmind.yaml"), "tools:\n  shell: 'not-a-boolean'\n");
    loadConfigFromFile(dir);
    const issue = getConfigLoadIssue();
    expect(issue).not.toBeNull();
    expect(issue!.path).toContain("metalmind.yaml");
    expect(issue!.reason).toMatch(/tools\.shell/);
  });

  it("reports a YAML syntax error with the file path", () => {
    writeFileSync(join(dir, "metalmind.yaml"), "tools:\n  - [unclosed\n");
    loadConfigFromFile(dir);
    expect(getConfigLoadIssue()?.reason).toMatch(/parse error|not a YAML mapping/i);
  });
});
