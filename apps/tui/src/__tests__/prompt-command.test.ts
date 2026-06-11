import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { XDG_CONFIG_FILE, loadXdgConfig } from "@metalmind/config";
import { handlePromptCommand, expandTemplate } from "../prompt-command.js";

describe("expandTemplate (#201)", () => {
  it("fills known vars and leaves unknown placeholders intact", () => {
    expect(expandTemplate("Review {{file}} for {{kind}}", { file: "a.ts", kind: "bugs" })).toBe(
      "Review a.ts for bugs",
    );
    expect(expandTemplate("Hi {{name}}", {})).toBe("Hi {{name}}");
  });
});

describe("/prompt command (#201)", () => {
  let backup: string | null = null;
  beforeEach(() => {
    backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null;
  });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("saves a template and persists it to config", () => {
    const r = handlePromptCommand("save review Review {{file}} for bugs and suggest fixes");
    expect(r).toEqual({ kind: "message", text: 'Saved prompt "review".' });
    expect(loadXdgConfig().prompts?.review).toBe("Review {{file}} for bugs and suggest fixes");
  });

  it("lists saved prompts", () => {
    handlePromptCommand("save greet Say hello to {{args}}");
    const r = handlePromptCommand("list");
    expect(r.kind).toBe("message");
    expect((r as { text: string }).text).toContain("greet");
  });

  it("expands a saved prompt with key=value vars and returns a run result", () => {
    handlePromptCommand("save review Review {{file}} for bugs");
    const r = handlePromptCommand("review file=src/app.ts");
    expect(r).toEqual({ kind: "run", prompt: "Review src/app.ts for bugs" });
  });

  it("fills {{args}} with the remaining free text", () => {
    handlePromptCommand("save explain Explain this clearly: {{args}}");
    const r = handlePromptCommand("explain how async generators work");
    expect(r).toEqual({ kind: "run", prompt: "Explain this clearly: how async generators work" });
  });

  it("reports an unknown prompt name", () => {
    const r = handlePromptCommand("doesnotexist");
    expect(r.kind).toBe("message");
    expect((r as { text: string }).text).toContain("No prompt named");
  });

  it("deletes a saved prompt", () => {
    handlePromptCommand("save temp throwaway {{args}}");
    expect(handlePromptCommand("delete temp")).toEqual({ kind: "message", text: 'Deleted prompt "temp".' });
    expect(loadXdgConfig().prompts?.temp).toBeUndefined();
  });
});
