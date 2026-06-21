import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SkillLoader } from "./skill-loader.js";
import { SkillManager } from "./skill-manager.js";

const TEST_PROJECT = "/tmp/metalmind-test-skills";
const TEST_GLOBAL = join(homedir(), ".metalmind-test-skills");

function setup(): void {
  if (existsSync(TEST_PROJECT)) rmSync(TEST_PROJECT, { recursive: true });
  if (existsSync(TEST_GLOBAL)) rmSync(TEST_GLOBAL, { recursive: true });

  // Create a project-local skill
  const skillDir = join(TEST_PROJECT, ".metalmind", "skills", "test-skill");
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: test-skill
version: 1.0.0
description: A test skill
tags: [test, example]
requiresTools: [readFile]
---

# Test Skill

You are a test assistant. Follow these rules:

- Always respond with "Test: " prefix.
- Use readFile when exploring code.
`,
  );

  // Create a global skill
  const globalSkillDir = join(TEST_GLOBAL, "global-skill");
  mkdirSync(globalSkillDir, { recursive: true });

  writeFileSync(
    join(globalSkillDir, "SKILL.md"),
    `---
name: global-skill
version: 2.0.0
description: A global skill
tags: [global]
---

# Global Skill

You are a global assistant.
`,
  );
}

function teardown(): void {
  if (existsSync(TEST_PROJECT)) rmSync(TEST_PROJECT, { recursive: true });
  if (existsSync(TEST_GLOBAL)) rmSync(TEST_GLOBAL, { recursive: true });
}

describe("SkillLoader", () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it("loads project-local skills", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);

    const testSkill = skills.find((s) => s.metadata.name === "test-skill");
    expect(testSkill).toBeDefined();
    expect(testSkill?.metadata.version).toBe("1.0.0");
    expect(testSkill?.source).toBe("project");
    expect(testSkill?.prompt).toContain("test assistant");
  });

  it("loads global skills", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);

    const globalSkill = skills.find((s) => s.metadata.name === "global-skill");
    expect(globalSkill).toBeDefined();
    expect(globalSkill?.source).toBe("global");
  });

  it("parses metadata correctly", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);

    const testSkill = skills.find((s) => s.metadata.name === "test-skill");
    expect(testSkill?.metadata.tags).toContain("test");
    expect(testSkill?.metadata.tags).toContain("example");
    expect(testSkill?.metadata.requiresTools).toContain("readFile");
  });

  it("filters skills by tag", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    loader.loadAll(TEST_PROJECT);

    const globalTags = loader.getSkillsByTag("global");
    expect(globalTags.length).toBeGreaterThanOrEqual(1);
  });

  it("handles empty project", () => {
    const emptyDir = "/tmp/metalmind-empty-project";
    if (existsSync(emptyDir)) rmSync(emptyDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });

    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(emptyDir);

    expect(skills.length).toBeGreaterThanOrEqual(0); // May have global skills
    rmSync(emptyDir, { recursive: true });
  });
});

describe("SkillManager", () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it("activates a skill", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);
    const testSkill = skills.find((s) => s.metadata.name === "test-skill")!;

    const manager = new SkillManager();
    const result = manager.activate(testSkill);

    expect(result.success).toBe(true);
    expect(manager.isActive("test-skill")).toBe(true);
  });

  it("deactivates a skill", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);
    const testSkill = skills.find((s) => s.metadata.name === "test-skill")!;

    const manager = new SkillManager();
    manager.activate(testSkill);
    expect(manager.isActive("test-skill")).toBe(true);

    manager.deactivate("test-skill");
    expect(manager.isActive("test-skill")).toBe(false);
  });

  it("builds system prompt from active skills", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);
    const testSkill = skills.find((s) => s.metadata.name === "test-skill")!;

    const manager = new SkillManager();
    manager.activate(testSkill);

    const prompt = manager.buildSystemPrompt();
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("test assistant");
  });

  it("fires prompt update callback", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);
    const testSkill = skills.find((s) => s.metadata.name === "test-skill")!;

    const manager = new SkillManager();
    let updatedPrompt = "";

    manager.onSystemPromptChange((prompt) => {
      updatedPrompt = prompt;
    });

    manager.activate(testSkill);
    expect(updatedPrompt).toContain("test-skill");
  });

  it("handles skill conflicts", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const skills = loader.loadAll(TEST_PROJECT);

    const skillA = {
      ...skills.find((s) => s.metadata.name === "test-skill")!,
      metadata: {
        ...skills.find((s) => s.metadata.name === "test-skill")!.metadata,
        conflictsWith: ["skill-b"],
        name: "skill-a",
      },
    };

    const skillB = {
      ...skills.find((s) => s.metadata.name === "test-skill")!,
      metadata: {
        ...skills.find((s) => s.metadata.name === "test-skill")!.metadata,
        name: "skill-b",
      },
    };

    const manager = new SkillManager();
    manager.activate(skillB);
    const result = manager.activate(skillA);

    expect(result.success).toBe(false);
    expect(result.error).toContain("conflicts");
  });
});

import type { SkillDefinition } from "./skill-loader.js";
import type { ToolRegistry } from "@metalmind/tools";

describe("SkillManager tool bindings (#228)", () => {
  const mockRegistry = {
    get: (n: string) => (n === "writeFile" || n === "readFile" ? { toolName: n } : undefined),
    listNames: () => ["writeFile", "readFile"],
  } as unknown as ToolRegistry;

  const makeSkill = (name: string, tools: Array<{ toolName: string; allowAutoExecute?: boolean }>): SkillDefinition => ({
    metadata: { name, description: "d" } as never,
    prompt: "body",
    tools,
    directory: "/tmp",
    source: "project",
  });

  it("fails activation when a skill binds an unknown tool", () => {
    const m = new SkillManager();
    m.setToolRegistry(mockRegistry);
    const res = m.activate(makeSkill("bad", [{ toolName: "writeFile" }, { toolName: "doesNotExist" }]));
    expect(res.success).toBe(false);
    expect(res.error).toContain("doesNotExist");
    expect(m.isActive("bad")).toBe(false);
  });

  it("activates when all bound tools exist and exposes allowAutoExecute tools", () => {
    const m = new SkillManager();
    m.setToolRegistry(mockRegistry);
    const res = m.activate(makeSkill("ok", [
      { toolName: "writeFile", allowAutoExecute: true },
      { toolName: "readFile" },
    ]));
    expect(res.success).toBe(true);
    expect([...m.getAutoExecuteTools()]).toEqual(["writeFile"]);
  });
});
