import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import type { SkillLoader, SkillMetadata } from "./skill-loader.js";
import type { SkillManager } from "./skill-manager.js";

export interface SkillCliResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/**
 * CLI commands for managing skills.
 * Used via: metalmind skill <command> [args]
 */
export class SkillCli {
  constructor(
    private loader: SkillLoader,
    private manager: SkillManager,
    private projectRoot: string,
  ) {}

  /**
   * List all available skills.
   */
  list(): SkillCliResult {
    const skills = this.loader.loadAll(this.projectRoot);

    if (skills.length === 0) {
      return {
        success: true,
        message: "No skills found. Create skills in .metalmind/skills/ or ~/.metalmind/skills/",
      };
    }

    const lines = skills.map((s) => {
      const active = this.manager.isActive(s.metadata.name) ? " [ACTIVE]" : "";
      return `  ${s.metadata.name} v${s.metadata.version} — ${s.metadata.description} (${s.source})${active}`;
    });

    return {
      success: true,
      message: `Available skills (${skills.length}):\n${lines.join("\n")}`,
      data: skills.map((s) => s.metadata),
    };
  }

  /**
   * Activate a skill by name.
   */
  activate(name: string): SkillCliResult {
    const skills = this.loader.loadAll(this.projectRoot);
    const skill = skills.find((s) => s.metadata.name === name);

    if (!skill) {
      return {
        success: false,
        message: `Skill "${name}" not found. Use 'metalmind skill list' to see available skills.`,
      };
    }

    const result = this.manager.activate(skill);
    if (result.success) {
      return {
        success: true,
        message: `Skill "${name}" activated. Prompt injected, tools registered.`,
      };
    }

    return {
      success: false,
      message: result.error ?? `Failed to activate skill "${name}"`,
    };
  }

  /**
   * Deactivate a skill by name.
   */
  deactivate(name: string): SkillCliResult {
    const removed = this.manager.deactivate(name);
    return {
      success: removed,
      message: removed
        ? `Skill "${name}" deactivated.`
        : `Skill "${name}" is not active.`,
    };
  }

  /**
   * Create a new skill from a template.
   */
  create(
    name: string,
    options: { global?: boolean; description?: string; tags?: string[] } = {},
  ): SkillCliResult {
    const dir = options.global
      ? join(this.loader["globalSkillsDir"], name)
      : join(this.projectRoot, ".metalmind", "skills", name);

    if (existsSync(dir)) {
      return {
        success: false,
        message: `Skill directory already exists: ${dir}`,
      };
    }

    const metadata: SkillMetadata = {
      name,
      version: "0.1.0",
      description: options.description ?? "A MetalMind skill",
      tags: options.tags,
    };

    const content = this.generateSkillFile(metadata);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);

    return {
      success: true,
      message: `Skill "${name}" created at ${dir}`,
      data: { path: dir },
    };
  }

  /**
   * Show details of a skill.
   */
  show(name: string): SkillCliResult {
    const skills = this.loader.loadAll(this.projectRoot);
    const skill = skills.find((s) => s.metadata.name === name);

    if (!skill) {
      return {
        success: false,
        message: `Skill "${name}" not found.`,
      };
    }

    const active = this.manager.isActive(name);
    const lines = [
      `Name: ${skill.metadata.name}`,
      `Version: ${skill.metadata.version}`,
      `Source: ${skill.source}`,
      `Directory: ${skill.directory}`,
      `Active: ${active ? "Yes" : "No"}`,
      `Description: ${skill.metadata.description}`,
      skill.metadata.author ? `Author: ${skill.metadata.author}` : "",
      skill.metadata.tags ? `Tags: ${skill.metadata.tags.join(", ")}` : "",
      skill.metadata.requiresTools
        ? `Requires tools: ${skill.metadata.requiresTools.join(", ")}`
        : "",
      "",
      "Prompt:",
      skill.prompt.slice(0, 500) + (skill.prompt.length > 500 ? "..." : ""),
    ];

    return {
      success: true,
      message: lines.filter(Boolean).join("\n"),
      data: skill,
    };
  }

  private generateSkillFile(metadata: SkillMetadata): string {
    const frontmatter = [
      "---",
      `name: ${metadata.name}`,
      `version: ${metadata.version}`,
      `description: ${metadata.description}`,
      metadata.author ? `author: ${metadata.author}` : "",
      metadata.tags?.length ? `tags: [${metadata.tags.join(", ")}]` : "",
      "---",
    ].filter(Boolean).join("\n");

    const prompt = `# ${metadata.name}

You are an expert assistant specialized in this skill area.

## Instructions
- Follow the conventions and best practices for this domain.
- Use available tools when appropriate.
- Provide clear, actionable guidance.

## Configuration
Customize this prompt to match your specific workflow needs.
`;

    return `${frontmatter}\n\n${prompt}`;
  }
}
