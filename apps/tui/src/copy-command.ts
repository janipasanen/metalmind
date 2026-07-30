import { spawnSync } from "node:child_process";

/**
 * Copy-to-clipboard support (#172): copy the last assistant message, or just the
 * last fenced code block, to the macOS clipboard via pbcopy. The extraction logic
 * is pure and tested; pbcopy is the only side effect.
 */

export interface CopyMessage {
  role: string;
  content: string;
}

/** Extract the last fenced code block's body from markdown text (without the fences). */
export function extractLastCodeBlock(text: string): string | null {
  const lines = text.split("\n");
  let end = -1;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("```")) {
      if (end === -1) end = i;
      else { start = i; break; }
    }
  }
  if (start === -1 || end === -1 || end <= start) return null;
  return lines.slice(start + 1, end).join("\n");
}

/** The most recent assistant message content, or null. */
export function lastAssistantMessage(messages: CopyMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.trim()) return messages[i].content;
  }
  return null;
}

/** Copy text to the macOS clipboard. Returns whether it succeeded. */
export function copyToClipboard(text: string): boolean {
  try {
    const res = spawnSync("pbcopy", { input: text });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Decide what to copy from `/copy [last|code|all|<n>]` and do it; returns a
 *  status message. `<n>` selects the nth assistant message counting back from
 *  the latest; `all` copies the whole conversation (#356). */
export function handleCopyCommand(arg: string, messages: CopyMessage[]): string {
  const what = arg.trim().toLowerCase() || "last";

  let payload: string | null;
  let label: string;
  if (what === "all") {
    payload = messages
      .filter((m) => m.content.trim())
      .map((m) => `${m.role === "user" ? "You" : m.role === "assistant" ? "AI" : "System"}: ${m.content}`)
      .join("\n\n");
    if (!payload) return "Nothing to copy yet.";
    label = "the whole conversation";
  } else if (/^\d+$/.test(what)) {
    const n = parseInt(what, 10);
    const assistants = messages.filter((m) => m.role === "assistant" && m.content.trim());
    if (n < 1 || n > assistants.length) {
      return assistants.length === 0
        ? "Nothing to copy yet."
        : `No assistant message #${n} — only ${assistants.length} so far (1 = most recent).`;
    }
    payload = assistants[assistants.length - n].content;
    label = n === 1 ? "the last message" : `assistant message #${n} from the end`;
  } else if (what === "code") {
    const lastMsg = lastAssistantMessage(messages);
    if (!lastMsg) return "Nothing to copy yet.";
    payload = extractLastCodeBlock(lastMsg);
    if (!payload) return "No code block found in the last message.";
    label = "the last code block";
  } else if (what === "last") {
    payload = lastAssistantMessage(messages);
    if (!payload) return "Nothing to copy yet.";
    label = "the last message";
  } else {
    return "Usage: /copy [last|code|all|<n>] — <n> is the nth assistant message counting back from the latest.";
  }

  if (!copyToClipboard(payload)) return "Couldn't access the clipboard (pbcopy).";
  const lines = payload.split("\n").length;
  return `Copied ${label} to the clipboard (${lines} line${lines === 1 ? "" : "s"}).`;
}
