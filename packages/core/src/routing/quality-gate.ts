/**
 * Quality gate — decides whether a model attempt is good enough, or whether the
 * router should escalate to a more capable (cloud) model. This is the trigger that
 * turns "try local first" into real automatic offloading.
 */

export interface AttemptResult {
  /** Assistant text produced this attempt. */
  text: string;
  /** Tool calls the model requested this attempt. */
  toolCalls: Array<{ toolName: string; argumentsJson: string }>;
  /** True if the provider call threw / errored. */
  errored: boolean;
}

export interface QualityVerdict {
  passed: boolean;
  reason: string;
}

const REFUSAL_PATTERN =
  /\b(i\s+(can'?t|cannot|am unable to|won'?t)|i'?m\s+(not able|unable)|as an ai\b)/i;

/**
 * Evaluate a single model attempt. Fails on: provider error, empty output,
 * malformed tool-call arguments, or an outright refusal with no tool use.
 */
export function evaluateQuality(result: AttemptResult): QualityVerdict {
  if (result.errored) {
    return { passed: false, reason: "provider error" };
  }

  const hasText = result.text.trim().length > 0;
  const hasToolCalls = result.toolCalls.length > 0;

  if (!hasText && !hasToolCalls) {
    return { passed: false, reason: "empty response" };
  }

  for (const tc of result.toolCalls) {
    try {
      JSON.parse(tc.argumentsJson);
    } catch {
      return { passed: false, reason: `invalid tool arguments for ${tc.toolName}` };
    }
  }

  // A refusal only counts when the model produced no tool call to act on.
  if (!hasToolCalls && REFUSAL_PATTERN.test(result.text)) {
    return { passed: false, reason: "model refusal" };
  }

  return { passed: true, reason: "ok" };
}
