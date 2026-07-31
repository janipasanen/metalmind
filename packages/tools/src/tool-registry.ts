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

  /** Actionable error for a tool the model invented or mistyped (#418).
   *  Naming near-misses lets it correct itself in one step instead of guessing
   *  again — and guesses tend to repeat, burning the iteration budget. */
  private unknownToolMessage(name: string): string {
    const available = this.listNames();
    const lower = name.toLowerCase();
    // Near-miss: same name modulo case/plural, or one contains the other.
    const near = available.filter((n) => {
      const l = n.toLowerCase();
      return l === lower || l === lower.replace(/s$/, "") || `${l}s` === lower || l.includes(lower) || lower.includes(l);
    });
    const suggestion = near.length
      ? ` Did you mean: ${near.slice(0, 3).join(", ")}?`
      : "";
    // Keep the full list bounded — it is an error path, not a tool listing.
    const listed = available.slice(0, 40).join(", ");
    const more = available.length > 40 ? `, …(+${available.length - 40} more)` : "";
    return `Tool "${name}" does not exist.${suggestion} Available tools: ${listed}${more}`;
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(this.unknownToolMessage(name));

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
