import type { AgentMessage } from "@metalmind/schemas";

/**
 * Rough token estimate for a string. Not exact (that needs a model tokenizer),
 * but far better than returning 0 — used by providers that lack a count API.
 * Blends the ~4-chars/token heuristic with a word-based estimate and adds a
 * small per-message overhead at the caller.
 */
export function roughTokenCount(text: string): number {
  if (!text) return 0;
  const byChars = Math.ceil(text.length / 4);
  const byWords = Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
  return Math.max(byChars, byWords);
}

/** Estimate tokens across a message list, including a small per-message overhead. */
export function roughTokenCountMessages(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += roughTokenCount(m.content) + 4; // role/format overhead
    if (m.toolCalls?.length) total += roughTokenCount(JSON.stringify(m.toolCalls));
  }
  return total;
}
