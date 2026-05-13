import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { load as parseYaml } from "js-yaml";

export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  requiresTools?: string[];
  conflictsWith?: string[];
}

export interface SkillDefinition {
  metadata: SkillMetadata;
  prompt: string;
  tools?: SkillToolBinding[];
  directory: string;
  source: "project" | "global";
}

export interface SkillToolBinding {
  toolName: string;
  config?: Record<string, unknown>;
  allowAutoExecute?: boolean;
}

const SKILL_FILE = "SKILL.md";
const METADATA_DELIMITER = "---";

/**
 * Discovers and loads skills from project-local and global directories.
 *
 * Skill Format (SKILL.md):
 *   ---
 *   name: my-skill
 *   version: 1.0.0
 *   description: Does something useful
 *   tags: [coding, review]
 *   requiresTools: [readFile, gitStatus]
 *   ---
 *
 *   # Skill Prompt
 *   You are an expert at...
 */
export class SkillLoader {
  private globalSkillsDir: string;
  private loadedSkills = new Map<string, SkillDefinition>();

  constructor(globalSkillsDir?: string) {
    this.globalSkillsDir = globalSkillsDir ?? join(homedir(), ".metalmind", "skills");
  }

  /**
   * Load all skills from both project and global directories.
   */
  loadAll(projectRoot: string): SkillDefinition[] {
    this.loadedSkills.clear();

    const projectSkillsDir = join(projectRoot, ".metalmind", "skills");
    const globalSkills = this.discoverSkills(this.globalSkillsDir, "global");
    const projectSkills = this.discoverSkills(projectSkillsDir, "project");

    // Project skills override global skills with the same name
    const allSkills = new Map<string, SkillDefinition>();

    for (const skill of globalSkills) {
      allSkills.set(skill.metadata.name, skill);
    }
    for (const skill of projectSkills) {
      allSkills.set(skill.metadata.name, skill);
    }

    for (const [name, skill] of allSkills) {
      this.loadedSkills.set(name, skill);
    }

    return [...this.loadedSkills.values()];
  }

  /**
   * Load a single skill from a directory.
   */
  loadSkill(skillDir: string, source: "project" | "global"): SkillDefinition | null {
    const skillFile = join(skillDir, SKILL_FILE);
    if (!existsSync(skillFile)) return null;

    try {
      const content = readFileSync(skillFile, "utf-8");
      return this.parseSkillFile(content, skillDir, source);
    } catch {
      return null;
    }
  }

  /**
   * Get a loaded skill by name.
   */
  getSkill(name: string): SkillDefinition | undefined {
    return this.loadedSkills.get(name);
  }

  /**
   * Get all loaded skills.
   */
  getSkills(): SkillDefinition[] {
    return [...this.loadedSkills.values()];
  }

  /**
   * Get skills by tag.
   */
  getSkillsByTag(tag: string): SkillDefinition[] {
    return this.getSkills().filter(
      (s) => s.metadata.tags?.includes(tag),
    );
  }

  /**
   * Clear all loaded skills.
   */
  clear(): void {
    this.loadedSkills.clear();
  }

  // ---- Private ----

  private discoverSkills(
    dir: string,
    source: "project" | "global",
  ): SkillDefinition[] {
    if (!existsSync(dir)) return [];

    const skills: SkillDefinition[] = [];

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            const skill = this.loadSkill(fullPath, source);
            if (skill) skills.push(skill);
          }
        } catch {
          // skip inaccessible entries
        }
      }
    } catch {
      // skip unreadable directories
    }

    return skills;
  }

  private parseSkillFile(
    content: string,
    directory: string,
    source: "project" | "global",
  ): SkillDefinition | null {
    // Extract YAML frontmatter
    const lines = content.split("\n");
    if (lines[0]?.trim() !== METADATA_DELIMITER) return null;

    const endDelimIndex = lines.findIndex(
      (line, i) => i > 0 && line.trim() === METADATA_DELIMITER,
    );
    if (endDelimIndex === -1) return null;

    const frontmatter = lines.slice(1, endDelimIndex).join("\n");
    const prompt = lines.slice(endDelimIndex + 1).join("\n").trim();

    let metadata: unknown;
    try {
      metadata = parseYaml(frontmatter);
    } catch {
      return null;
    }

    if (!metadata || typeof metadata !== "object") return null;

    const meta = metadata as Record<string, unknown>;

    return {
      metadata: {
        name: String(meta.name ?? basename(directory)),
        version: String(meta.version ?? "0.1.0"),
        description: String(meta.description ?? ""),
        author: meta.author ? String(meta.author) : undefined,
        tags: Array.isArray(meta.tags)
          ? meta.tags.map(String)
          : undefined,
        requiresTools: Array.isArray(meta.requiresTools)
          ? meta.requiresTools.map(String)
          : undefined,
        conflictsWith: Array.isArray(meta.conflictsWith)
          ? meta.conflictsWith.map(String)
          : undefined,
      },
      prompt,
      tools: this.parseTools(meta.tools),
      directory,
      source,
    };
  }

  private parseTools(
    raw: unknown,
  ): SkillToolBinding[] | undefined {
    if (!Array.isArray(raw)) return undefined;

    return raw.map((t: unknown) => {
      if (typeof t === "object" && t !== null) {
        const obj = t as Record<string, unknown>;
        return {
          toolName: String(obj.toolName ?? ""),
          config: obj.config as Record<string, unknown> | undefined,
          allowAutoExecute: Boolean(obj.allowAutoExecute),
        };
      }
      return { toolName: String(t) };
    });
  }
}
