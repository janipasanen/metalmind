import { z, type ZodSchema } from "zod";
import type { AgentTool, ToolExecutionContext, ToolAuditEntry } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.toolName)) {
      throw new Error(`Tool "${tool.toolName}" is already registered`);
    }
    this.tools.set(tool.toolName, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not found in registry`);

    const validationResult = tool.inputSchema.safeParse(input);
    if (!validationResult.success) {
      const errors = validationResult.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ");
      throw new Error(`Invalid input for "${name}": ${errors}`);
    }
    const validated = validationResult.data;

    const startTime = new Date().toISOString();
    let output: unknown;
    let success = true;
    let error: string | undefined;

    try {
      output = await tool.execute(validated, context);
      return output;
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const entry: ToolAuditEntry = {
        timestamp: startTime,
        toolName: name,
        input: validated,
        output,
        success,
        error,
      };
      context.auditLog?.(entry);
    }
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }
}

export function parseInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
