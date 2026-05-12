import { TaskClassifier } from "./task-classifier.js";
import { ModelRouter } from "./model-router.js";

export { TaskClassifier } from "./task-classifier.js";
export { ModelRouter } from "./model-router.js";
export type { TaskTier, TaskClassification } from "./task-classifier.js";
export type { RouteDecision, RoutingConfig } from "./model-router.js";

export class FallbackManager {
  private fallbackChain: string[];
  private failures = new Map<string, number>();
  private maxAttempts: number;

  constructor(fallbackChain: string[] = ["ollama", "openai", "anthropic"], maxAttempts = 3) {
    this.fallbackChain = fallbackChain;
    this.maxAttempts = maxAttempts;
  }

  /**
   * Get the next provider to try after a failure.
   */
  nextProvider(currentProvider: string): string | null {
    const idx = this.fallbackChain.indexOf(currentProvider);
    if (idx < 0 || idx >= this.fallbackChain.length - 1) return null;
    return this.fallbackChain[idx + 1];
  }

  /**
   * Record a provider failure for a task.
   */
  recordFailure(taskId: string, provider: string): { shouldFallback: boolean; nextProvider: string | null } {
    const count = (this.failures.get(taskId) ?? 0) + 1;
    this.failures.set(taskId, count);

    if (count >= this.maxAttempts) {
      return { shouldFallback: false, nextProvider: null };
    }

    const next = this.nextProvider(provider);
    return { shouldFallback: next !== null, nextProvider: next };
  }

  /**
   * Reset tracking for a task.
   */
  reset(taskId: string): void {
    this.failures.delete(taskId);
  }
}
