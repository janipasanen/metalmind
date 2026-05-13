import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SkillLoader } from "./skill-loader.js";
import { SkillManager } from "./skill-manager.js";
import { SkillCli } from "./skill-cli.js";

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

describe("SkillCli", () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it("lists available skills", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const manager = new SkillManager();
    const cli = new SkillCli(loader, manager, TEST_PROJECT);

    const result = cli.list();
    expect(result.success).toBe(true);
    expect(result.message).toContain("test-skill");
  });

  it("activates a skill via name", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const manager = new SkillManager();
    const cli = new SkillCli(loader, manager, TEST_PROJECT);

    const result = cli.activate("test-skill");
    expect(result.success).toBe(true);
    expect(manager.isActive("test-skill")).toBe(true);
  });

  it("fails to activate unknown skill", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const manager = new SkillManager();
    const cli = new SkillCli(loader, manager, TEST_PROJECT);

    const result = cli.activate("nonexistent");
    expect(result.success).toBe(false);
  });

  it("deactivates a skill", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const manager = new SkillManager();
    const cli = new SkillCli(loader, manager, TEST_PROJECT);

    cli.activate("test-skill");
    const result = cli.deactivate("test-skill");
    expect(result.success).toBe(true);
    expect(manager.isActive("test-skill")).toBe(false);
  });

  it("shows skill details", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const manager = new SkillManager();
    const cli = new SkillCli(loader, manager, TEST_PROJECT);

    const result = cli.show("test-skill");
    expect(result.success).toBe(true);
    expect(result.message).toContain("test-skill");
    expect(result.message).toContain("1.0.0");
  });

  it("creates a new skill from template", () => {
    const loader = new SkillLoader(TEST_GLOBAL);
    const manager = new SkillManager();
    const cli = new SkillCli(loader, manager, TEST_PROJECT);

    const result = cli.create("new-skill", { description: "My new skill" });
    expect(result.success).toBe(true);

    // Verify the file was created
    const skillFile = join(
      TEST_PROJECT,
      ".metalmind",
      "skills",
      "new-skill",
      "SKILL.md",
    );
    expect(existsSync(skillFile)).toBe(true);
  });
});
