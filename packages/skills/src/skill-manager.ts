import type { SkillDefinition, SkillToolBinding } from "./skill-loader.js";
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

  /**
   * Set the tool registry for dynamic tool registration.
   */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
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

    // Check required tool availability
    if (skill.metadata.requiresTools && this.toolRegistry) {
      const availableTools = new Set(this.toolRegistry.listNames());
      for (const requiredTool of skill.metadata.requiresTools) {
        if (!availableTools.has(requiredTool)) {
          return {
            success: false,
            error: `Skill "${skill.metadata.name}" requires tool "${requiredTool}" which is not available`,
          };
        }
      }
    }

    // Register skill-specific tools
    if (skill.tools && this.toolRegistry) {
      for (const binding of skill.tools) {
        if (!this.toolRegistry.get(binding.toolName)) {
          // Tool not in registry — could register a wrapper
          // For now, log a warning
        }
      }
    }

    this.activeSkills.set(skill.metadata.name, {
      skill,
      activatedAt: new Date(),
    });

    this.notifyPromptUpdate();
    return { success: true };
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
   * Get tool bindings from all active skills.
   */
  getActiveToolBindings(): SkillToolBinding[] {
    const bindings: SkillToolBinding[] = [];
    for (const active of this.activeSkills.values()) {
      if (active.skill.tools) {
        bindings.push(...active.skill.tools);
      }
    }
    return bindings;
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
