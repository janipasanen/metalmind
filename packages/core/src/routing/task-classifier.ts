/**
 * Task classifier — determines task complexity to route to appropriate model tier.
 *
 * Tier 1 (local fast): simple file ops, explanations, commit messages, filename search
 * Tier 2 (medium): moderate refactors, test fixes, debugging with output
 * Tier 3 (cloud reasoning): architecture, large multi-file, complex debugging, planning
 */

import { estimateTokens } from "./cost-tracker.js";

export type TaskTier = "tier1-local" | "tier2-medium" | "tier3-cloud";

/** Matches path-like tokens that carry a 2-4 letter file extension (auth.ts, App.tsx, package.json). */
const FILE_REFERENCE_PATTERN = /\b[\w/-]+\.[a-z]{2,4}\b/gi;

/** Count distinct file references in a request (real paths, not the literal word "file"). */
export function countFileReferences(input: string): number {
  const matches = input.match(FILE_REFERENCE_PATTERN);
  if (!matches) return 0;
  return new Set(matches.map((m) => m.toLowerCase())).size;
}

export interface TaskClassification {
  tier: TaskTier;
  reasoning: string;
  confidence: number; // 0-1
  suggestedMaxTokens?: number;
}

const TIER1_PATTERNS = [
  /\b(read|list|find|search|show|what|which|how does)\b/i,
  /\bexplain\b/i,
  /commit\s*message/i,
  /\b(summarize|summary)\b/i,
  /\bfind\s+where\b/i,
  /\bfilename\b/i,
];

const TIER3_PATTERNS = [
  /\b(architect|design|plan|system)\b/i,
  /\b(refactor|migrate|rewrite|overhaul)\b/i,
  /\bmulti[-\s]file\b/i,
  /\bdebug\s+(complex|failing|intermittent)\b/i,
  /\b(security|vulnerability|threat)\b/i,
  /\bdeploy|ci[/-]cd|pipeline\b/i,
  /\bperformance\s+(optimiz|bottleneck|profile)\b/i,
];

export class TaskClassifier {
  /**
   * Classify a user request into a model tier.
   */
  classify(request: string): TaskClassification {
    const input = request.trim();

    const hasTier3 = TIER3_PATTERNS.some((p) => p.test(input));
    if (hasTier3) {
      return {
        tier: "tier3-cloud",
        reasoning: "Complex task requiring architectural reasoning",
        confidence: 0.85,
        suggestedMaxTokens: 16_000,
      };
    }

    const hasTier1 = TIER1_PATTERNS.some((p) => p.test(input));
    const fileCount = countFileReferences(input);
    const isMultiStep =
      /\b(then|after that|next|also|and also)\b/i.test(input);
    const tokenEstimate = estimateTokens(input);

    if (hasTier1 && !isMultiStep && tokenEstimate < 1000) {
      return {
        tier: "tier1-local",
        reasoning: "Simple read/explain/search task",
        confidence: 0.9,
        suggestedMaxTokens: 4_000,
      };
    }

    if (isMultiStep || fileCount >= 2 || tokenEstimate >= 2000) {
      return {
        tier: "tier3-cloud",
        reasoning: "Multi-step or multi-file task",
        confidence: 0.75,
        suggestedMaxTokens: 8_000,
      };
    }

    if (/\b(edit|change|modify|update|fix|add|create)\b/i.test(input)) {
      return {
        tier: "tier2-medium",
        reasoning: "Edit/modification task",
        confidence: 0.7,
        suggestedMaxTokens: 8_000,
      };
    }

    return {
      tier: "tier1-local",
      reasoning: "Default to local for fast response",
      confidence: 0.6,
      suggestedMaxTokens: 4_000,
    };
  }
}
