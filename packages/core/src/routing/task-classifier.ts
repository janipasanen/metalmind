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
  /** Whether the task will likely require tool calls (file ops, shell, git). */
  needsTools: boolean;
  /** Whether the task involves images / vision input. */
  needsVision: boolean;
  /** Estimated total context tokens (request + attached files + history). */
  estimatedContextTokens: number;
}

/** Optional structured context that sharpens classification beyond the prompt text. */
export interface ClassificationContext {
  /** Contents (or text) of files attached to the request. */
  attachedFiles?: string[];
  /** Tokens already accumulated in the conversation history. */
  historyTokens?: number;
  /** Number of prior turns in the conversation. */
  conversationDepth?: number;
  /** Whether the request includes image input. */
  hasImages?: boolean;
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

/** Complex build verbs that imply non-trivial work even without other signals. */
const COMPLEX_VERB_PATTERN = /\b(implement|integrate|diagnose|optimize)\b/i;

/** Verbs/keywords implying the agent will need to call tools. */
const TOOL_VERB_PATTERN =
  /\b(read|list|search|find|show|edit|change|modify|update|fix|add|create|write|delete|remove|rename|run|refactor|implement|build|integrate|migrate|test)\b/i;

/** Heuristics that detect a pasted error / stack trace (a strong "hard debugging" signal). */
const STACK_TRACE_PATTERNS = [
  /Traceback \(most recent call last\)/,
  /\b\w*(Error|Exception):\s/, // TypeError: , ValueError:
  /\n\s*at\s+.+:\d+:\d+/, // JS stack frame: at fn (file:line:col)
  /\bFile ".+", line \d+/, // Python frame
];

const DEEP_CONVERSATION_THRESHOLD = 6;
const LARGE_CONTEXT_TOKENS = 2000;

export function hasStackTrace(input: string): boolean {
  return STACK_TRACE_PATTERNS.some((p) => p.test(input));
}

export class TaskClassifier {
  /**
   * Classify a user request into a model tier, using both the prompt text and
   * optional structured context (attached files, history size, depth, images).
   */
  classify(request: string, context: ClassificationContext = {}): TaskClassification {
    const input = request.trim();

    const fileCount = countFileReferences(input);
    const isMultiStep = /\b(then|after that|next|also|and also)\b/i.test(input);
    const hasTier1 = TIER1_PATTERNS.some((p) => p.test(input));
    const hasTier3Keyword = TIER3_PATTERNS.some((p) => p.test(input));
    const hasComplexVerb = COMPLEX_VERB_PATTERN.test(input);
    const hasError = hasStackTrace(input);
    const depth = context.conversationDepth ?? 0;

    const attachedTokens = (context.attachedFiles ?? []).reduce(
      (sum, f) => sum + estimateTokens(f),
      0,
    );
    const estimatedContextTokens =
      estimateTokens(input) + attachedTokens + (context.historyTokens ?? 0);

    const needsVision = context.hasImages ?? false;
    const needsTools = fileCount > 0 || hasError || TOOL_VERB_PATTERN.test(input);

    const signals = { needsTools, needsVision, estimatedContextTokens };

    // Strong complexity signals → cloud reasoning.
    if (hasTier3Keyword || hasComplexVerb || hasError) {
      return {
        tier: "tier3-cloud",
        reasoning: hasError
          ? "Pasted error/stack trace — complex debugging"
          : hasComplexVerb
            ? "Complex implementation/integration task"
            : "Complex task requiring architectural reasoning",
        confidence: 0.85,
        suggestedMaxTokens: 16_000,
        ...signals,
      };
    }

    // Simple, self-contained read/explain/search → local.
    if (hasTier1 && !isMultiStep && estimatedContextTokens < 1000) {
      return {
        tier: "tier1-local",
        reasoning: "Simple read/explain/search task",
        confidence: 0.9,
        suggestedMaxTokens: 4_000,
        ...signals,
      };
    }

    // Breadth/size signals → cloud.
    if (
      isMultiStep ||
      fileCount >= 2 ||
      estimatedContextTokens >= LARGE_CONTEXT_TOKENS ||
      depth >= DEEP_CONVERSATION_THRESHOLD
    ) {
      return {
        tier: "tier3-cloud",
        reasoning:
          depth >= DEEP_CONVERSATION_THRESHOLD
            ? "Deep multi-turn session — escalating to cloud"
            : "Multi-step, multi-file, or large-context task",
        confidence: 0.75,
        suggestedMaxTokens: 8_000,
        ...signals,
      };
    }

    if (/\b(edit|change|modify|update|fix|add|create)\b/i.test(input)) {
      return {
        tier: "tier2-medium",
        reasoning: "Edit/modification task",
        confidence: 0.7,
        suggestedMaxTokens: 8_000,
        ...signals,
      };
    }

    return {
      tier: "tier1-local",
      reasoning: "Default to local for fast response",
      confidence: 0.6,
      suggestedMaxTokens: 4_000,
      ...signals,
    };
  }
}
