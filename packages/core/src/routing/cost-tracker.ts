export interface ProviderUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
  success: boolean;
}

export interface UsageSummary {
  totalCalls: number;
  totalTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  byProvider: Map<string, { calls: number; tokens: number; cost: number }>;
}

const COST_PER_1K_TOKENS: Record<string, Record<string, number>> = {
  openai: { "gpt-4": 0.03, "gpt-4-turbo": 0.01, default: 0.01 },
  anthropic: { "claude-sonnet-latest": 0.015, "claude-opus": 0.075, default: 0.015 },
  ollama: { default: 0 },
};

export class CostTracker {
  private usageLog: ProviderUsage[] = [];

  recordUsage(usage: ProviderUsage): void {
    this.usageLog.push(usage);
  }

  estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    const providerRates = COST_PER_1K_TOKENS[provider] ?? {};
    const rate = providerRates[model] ?? providerRates["default"] ?? 0;
    return ((inputTokens + outputTokens) / 1000) * rate;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getSummary(): UsageSummary {
    const summary: UsageSummary = {
      totalCalls: this.usageLog.length,
      totalTokens: 0,
      totalCostUsd: 0,
      totalLatencyMs: 0,
      byProvider: new Map(),
    };

    for (const entry of this.usageLog) {
      const tokens = entry.inputTokens + entry.outputTokens;
      summary.totalTokens += tokens;
      summary.totalCostUsd += entry.costUsd;
      summary.totalLatencyMs += entry.latencyMs;

      const existing = summary.byProvider.get(entry.provider) ?? {
        calls: 0,
        tokens: 0,
        cost: 0,
      };
      existing.calls++;
      existing.tokens += tokens;
      existing.cost += entry.costUsd;
      summary.byProvider.set(entry.provider, existing);
    }

    return summary;
  }

  getRecentUsage(n = 20): ProviderUsage[] {
    return this.usageLog.slice(-n);
  }

  clear(): void {
    this.usageLog = [];
  }
}

export class LatencyTracker {
  private samples: number[] = [];

  record(durationMs: number): void {
    this.samples.push(durationMs);
  }

  getAverage(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
  }

  getP95(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[idx];
  }

  getMin(): number {
    return this.samples.length === 0 ? 0 : Math.min(...this.samples);
  }

  getMax(): number {
    return this.samples.length === 0 ? 0 : Math.max(...this.samples);
  }

  reset(): void {
    this.samples = [];
  }
}
