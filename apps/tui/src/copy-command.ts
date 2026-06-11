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

/** Decide what to copy from `/copy [last|code]` and do it; returns a status message. */
export function handleCopyCommand(arg: string, messages: CopyMessage[]): string {
  const what = arg.trim().toLowerCase() || "last";
  const lastMsg = lastAssistantMessage(messages);
  if (!lastMsg) return "Nothing to copy yet.";

  let payload: string | null;
  if (what === "code") {
    payload = extractLastCodeBlock(lastMsg);
    if (!payload) return "No code block found in the last message.";
  } else {
    payload = lastMsg;
  }

  if (!copyToClipboard(payload)) return "Couldn't access the clipboard (pbcopy).";
  const lines = payload.split("\n").length;
  return `Copied ${what === "code" ? "the last code block" : "the last message"} to the clipboard (${lines} line${lines === 1 ? "" : "s"}).`;
}
