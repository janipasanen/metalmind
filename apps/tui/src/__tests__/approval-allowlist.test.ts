import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { XDG_CONFIG_FILE, loadXdgConfig } from "@metalmind/config";
import { isAllowlisted, globToRegExp, handleAllowCommand } from "../approval-allowlist.js";

describe("globToRegExp (#220)", () => {
  it("matches ** across slashes and * within a segment", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/index.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/index.ts")).toBe(false);
    expect(globToRegExp("src/**").test("test/x.ts")).toBe(false);
  });
});

describe("isAllowlisted (#220)", () => {
  it("allows by tool name", () => {
    expect(isAllowlisted({ tools: ["writeFile"] }, "writeFile", { path: "x" })).toBe(true);
    expect(isAllowlisted({ tools: ["writeFile"] }, "deleteFile", { path: "x" })).toBe(false);
  });
  it("allows file ops under a path glob", () => {
    expect(isAllowlisted({ paths: ["src/**"] }, "editFile", { path: "src/a/b.ts" })).toBe(true);
    expect(isAllowlisted({ paths: ["src/**"] }, "editFile", { path: "config/secret" })).toBe(false);
  });
  it("allows commands by prefix", () => {
    expect(isAllowlisted({ commands: ["npm test"] }, "runCommand", { command: "npm test -- --watch" })).toBe(true);
    expect(isAllowlisted({ commands: ["npm test"] }, "runCommand", { command: "rm -rf /" })).toBe(false);
  });
  it("returns false for an empty allowlist", () => {
    expect(isAllowlisted(undefined, "writeFile", { path: "x" })).toBe(false);
    expect(isAllowlisted({}, "writeFile", { path: "x" })).toBe(false);
  });
});

describe("/allow command (#220)", () => {
  let backup: string | null = null;
  beforeEach(() => { backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null; });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("persists tool/path/command entries and lists/clears them", () => {
    expect(handleAllowCommand("tool writeFile")).toContain("Allowlisted");
    handleAllowCommand("path src/**");
    handleAllowCommand("command npm test");
    const cfg = loadXdgConfig();
    expect(cfg.approvalAllowlist?.tools).toContain("writeFile");
    expect(cfg.approvalAllowlist?.paths).toContain("src/**");
    expect(cfg.approvalAllowlist?.commands).toContain("npm test");

    expect(handleAllowCommand("list")).toContain("writeFile");
    expect(handleAllowCommand("clear")).toContain("cleared");
    expect(loadXdgConfig().approvalAllowlist).toEqual({});
  });
});
