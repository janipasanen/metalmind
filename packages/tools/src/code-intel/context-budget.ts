import type { EnhancedEntry } from "./repo-map-v2.js";

export interface BudgetAllocation {
  filePath: string;
  tokenBudget: number;
  priority: "critical" | "high" | "medium" | "low";
  reason: string;
}

export interface ContextBudgetResult {
  totalBudget: number;
  allocated: number;
  remaining: number;
  allocations: BudgetAllocation[];
}

/**
 * Calculates token budgets for context windows.
 * Prioritizes relevant files and manages context efficiently.
 */
export class ContextBudgetOptimizer {
  private tokenEstimator: (text: string) => number;

  constructor(tokenEstimator?: (text: string) => number) {
    // Default: ~4 chars per token (rough estimate)
    this.tokenEstimator = tokenEstimator ?? ((text) => Math.ceil(text.length / 4));
  }

  /**
   * Allocate context budgets across files based on relevance and model limits.
   */
  allocate(
    entries: EnhancedEntry[],
    modelContextLimit: number,
    systemPromptTokens = 500,
  ): ContextBudgetResult {
    // Reserve budget for system prompt and conversation history
    const availableBudget = Math.max(0, modelContextLimit - systemPromptTokens - 2000);

    // Filter and sort files by relevance
    const files = entries
      .filter((e) => e.type === "file")
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));

    const allocations: BudgetAllocation[] = [];
    let allocated = 0;

    // Tier-based allocation
    const tiers = this.categorizeFiles(files);

    // Critical files: full content (up to 2000 tokens each)
    for (const file of tiers.critical) {
      const budget = Math.min(2000, file.size / 4);
      if (allocated + budget > availableBudget) break;
      allocations.push({
        filePath: file.path,
        tokenBudget: budget,
        priority: "critical",
        reason: `${file.exportedSymbols} exports, ${file.relevanceScore?.toFixed(0) ?? 0} relevance`,
      });
      allocated += budget;
    }

    // High priority: up to 1500 tokens each
    for (const file of tiers.high) {
      const budget = Math.min(1500, file.size / 4);
      if (allocated + budget > availableBudget) break;
      allocations.push({
        filePath: file.path,
        tokenBudget: budget,
        priority: "high",
        reason: `Relevance: ${file.relevanceScore?.toFixed(1) ?? "N/A"}`,
      });
      allocated += budget;
    }

    // Medium priority: up to 800 tokens each
    for (const file of tiers.medium) {
      const budget = Math.min(800, file.size / 4);
      if (allocated + budget > availableBudget) break;
      allocations.push({
        filePath: file.path,
        tokenBudget: budget,
        priority: "medium",
        reason: "Moderate relevance",
      });
      allocated += budget;
    }

    // Low priority: summarized (200 tokens each)
    for (const file of tiers.low.slice(0, 10)) {
      const budget = 200;
      if (allocated + budget > availableBudget) break;
      allocations.push({
        filePath: file.path,
        tokenBudget: budget,
        priority: "low",
        reason: "Summary only",
      });
      allocated += budget;
    }

    return {
      totalBudget: modelContextLimit,
      allocated,
      remaining: availableBudget - allocated,
      allocations,
    };
  }

  /**
   * Calculate total estimated tokens for a set of files.
   */
  estimateTokens(contents: Map<string, string>): number {
    let total = 0;
    for (const [, content] of contents) {
      total += this.tokenEstimator(content);
    }
    return total;
  }

  /**
   * Check if content fits within a budget, considering overhead.
   */
  fitsBudget(content: string, maxTokens: number, overheadFactor = 1.1): boolean {
    return this.tokenEstimator(content) * overheadFactor <= maxTokens;
  }

  /**
   * Summarize a budget allocation as a human-readable report.
   */
  formatReport(result: ContextBudgetResult): string {
    const lines = [
      `Context Budget Report`,
      `  Model limit: ${result.totalBudget} tokens`,
      `  Allocated: ${result.allocated} tokens`,
      `  Remaining: ${result.remaining} tokens`,
      ``,
      `Allocations by priority:`,
    ];

    const byPriority = new Map<string, BudgetAllocation[]>();
    for (const a of result.allocations) {
      const list = byPriority.get(a.priority) ?? [];
      list.push(a);
      byPriority.set(a.priority, list);
    }

    for (const [priority, allocs] of byPriority) {
      const total = allocs.reduce((s, a) => s + a.tokenBudget, 0);
      lines.push(`  [${priority}] ${allocs.length} files (${total} tokens)`);
      for (const a of allocs) {
        lines.push(`    ${a.filePath} — ${a.tokenBudget} tokens (${a.reason})`);
      }
    }

    return lines.join("\n");
  }

  private categorizeFiles(files: EnhancedEntry[]): {
    critical: EnhancedEntry[];
    high: EnhancedEntry[];
    medium: EnhancedEntry[];
    low: EnhancedEntry[];
  } {
    const result = {
      critical: [] as EnhancedEntry[],
      high: [] as EnhancedEntry[],
      medium: [] as EnhancedEntry[],
      low: [] as EnhancedEntry[],
    };

    for (const file of files) {
      const score = file.relevanceScore ?? 0;
      if (score > 20) {
        result.critical.push(file);
      } else if (score > 5) {
        result.high.push(file);
      } else if (score > 1) {
        result.medium.push(file);
      } else {
        result.low.push(file);
      }
    }

    return result;
  }
}
