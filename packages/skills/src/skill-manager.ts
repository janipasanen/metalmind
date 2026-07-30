import type { SkillDefinition } from "./skill-loader.js";
import type { ToolRegistry } from "@metalmind/tools";

export interface ActiveSkill {
  skill: SkillDefinition;
  activatedAt: Date;
}

/**
 * Manages skill activation, prompt injection, and tool bindings.
 * Supports concurrent skills where safe.
 */
export class SkillManager {
  private activeSkills = new Map<string, ActiveSkill>();
  private toolRegistry: ToolRegistry | null = null;
  private onPromptUpdate?: (systemPrompt: string) => void;
  /** Names of tools that exist OUTSIDE the built-in registry (MCP servers).
   *  Without this a skill that requires or binds an MCP tool could never
   *  activate — the registry only knows the built-ins (#380). */
  private externalTools: () => Iterable<string> = () => [];

  /**
   * Set the tool registry for dynamic tool registration.
   */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Supply a live view of dynamically-registered (MCP) tool names (#380).
   *  A callback, not a snapshot: servers connect and die during a session. */
  setExternalToolSource(source: () => Iterable<string>): void {
    this.externalTools = source;
  }

  private knownTools(): Set<string> {
    const names = new Set<string>(this.toolRegistry?.listNames() ?? []);
    for (const n of this.externalTools()) names.add(n);
    return names;
  }

  /**
   * Set callback for when the system prompt changes.
   */
  onSystemPromptChange(callback: (systemPrompt: string) => void): void {
    this.onPromptUpdate = callback;
  }

  /**
   * Activate a skill: inject its prompt and register its tools.
   */
  activate(skill: SkillDefinition): { success: boolean; error?: string } {
    // Check for conflicts
    if (skill.metadata.conflictsWith) {
      for (const conflictName of skill.metadata.conflictsWith) {
        if (this.activeSkills.has(conflictName)) {
          return {
            success: false,
            error: `Skill "${skill.metadata.name}" conflicts with active skill "${conflictName}"`,
          };
        }
      }
    }

    // Check required tool availability (built-ins + connected MCP tools, #380)
    if (skill.metadata.requiresTools && this.toolRegistry) {
      const availableTools = this.knownTools();
      for (const requiredTool of skill.metadata.requiresTools) {
        if (!availableTools.has(requiredTool)) {
          return {
            success: false,
            error: `Skill "${skill.metadata.name}" requires tool "${requiredTool}" which is not available`,
          };
        }
      }
    }

    // Validate tool bindings: don't silently swallow a skill that binds a tool
    // that doesn't exist — fail activation loudly (#228).
    if (skill.tools && this.toolRegistry) {
      const known = this.knownTools();
      const missing = skill.tools.map((b) => b.toolName).filter((n) => n && !known.has(n));
      if (missing.length > 0) {
        return { success: false, error: `Skill "${skill.metadata.name}" binds unknown tool(s): ${missing.join(", ")}` };
      }
    }

    this.activeSkills.set(skill.metadata.name, {
      skill,
      activatedAt: new Date(),
    });

    this.notifyPromptUpdate();
    return { success: true };
  }

  /** Tools that active skills marked allowAutoExecute — the agent pre-approves these (#228). */
  getAutoExecuteTools(): Set<string> {
    const out = new Set<string>();
    for (const { skill } of this.activeSkills.values()) {
      for (const b of skill.tools ?? []) {
        if (b.allowAutoExecute && b.toolName) out.add(b.toolName);
      }
    }
    return out;
  }

  /**
   * Deactivate a skill.
   */
  deactivate(skillName: string): boolean {
    const removed = this.activeSkills.delete(skillName);
    if (removed) {
      this.notifyPromptUpdate();
    }
    return removed;
  }

  /**
   * Check if a skill is active.
   */
  isActive(skillName: string): boolean {
    return this.activeSkills.has(skillName);
  }

  /**
   * Get all active skills.
   */
  getActiveSkills(): ActiveSkill[] {
    return [...this.activeSkills.values()];
  }

  /**
   * Build the combined system prompt from all active skills.
   */
  buildSystemPrompt(): string {
    if (this.activeSkills.size === 0) return "";

    const prompts: string[] = [];
    for (const active of this.activeSkills.values()) {
      prompts.push(
        `<!-- Skill: ${active.skill.metadata.name} v${active.skill.metadata.version} -->\n${active.skill.prompt}`,
      );
    }

    return prompts.join("\n\n");
  }

  /**
   * Deactivate all skills.
   */
  deactivateAll(): void {
    this.activeSkills.clear();
    this.notifyPromptUpdate();
  }

  private notifyPromptUpdate(): void {
    if (this.onPromptUpdate) {
      this.onPromptUpdate(this.buildSystemPrompt());
    }
  }
}
