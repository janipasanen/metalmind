import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";

/**
 * Prompt library (#201): save, list, delete, and use named prompt templates.
 * Templates may contain {{var}} placeholders filled from `key=value` arguments
 * at use time, plus a special {{args}} for the remaining free text.
 */

export type PromptResult =
  | { kind: "message"; text: string }
  | { kind: "run"; prompt: string };

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

function parseArgs(tokens: string[]): { vars: Record<string, string>; rest: string } {
  const vars: Record<string, string> = {};
  const positional: string[] = [];
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq > 0) vars[t.slice(0, eq)] = t.slice(eq + 1);
    else positional.push(t);
  }
  vars.args = positional.join(" ");
  return { vars, rest: positional.join(" ") };
}

export function handlePromptCommand(rawArgs: string): PromptResult {
  const trimmed = rawArgs.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "list";

  if (sub === "list" || sub === "ls") {
    const prompts = loadXdgConfig().prompts ?? {};
    const names = Object.keys(prompts).sort();
    if (names.length === 0) {
      return { kind: "message", text: "No saved prompts. Save one with `/prompt save <name> <template>`." };
    }
    const lines = names.map((n) => `  ${n.padEnd(16)} ${truncate(prompts[n], 60)}`);
    return { kind: "message", text: ["Saved prompts (use with `/prompt <name> key=value`):", ...lines].join("\n") };
  }

  if (sub === "save") {
    const name = parts[1];
    const template = trimmed.slice(trimmed.indexOf(name) + name.length).trim();
    if (!name || !template) {
      return { kind: "message", text: "Usage: /prompt save <name> <template…>  (template may use {{vars}} and {{args}})" };
    }
    const cfg = loadXdgConfig();
    saveXdgConfig({ ...cfg, prompts: { ...(cfg.prompts ?? {}), [name]: template } });
    return { kind: "message", text: `Saved prompt "${name}".` };
  }

  if (sub === "delete" || sub === "rm") {
    const name = parts[1];
    const cfg = loadXdgConfig();
    const prompts = { ...(cfg.prompts ?? {}) };
    if (!name || !prompts[name]) return { kind: "message", text: `No prompt named "${name ?? ""}".` };
    delete prompts[name];
    saveXdgConfig({ ...cfg, prompts });
    return { kind: "message", text: `Deleted prompt "${name}".` };
  }

  // Otherwise treat the first token as a prompt name to expand and run.
  const prompts = loadXdgConfig().prompts ?? {};
  const template = prompts[sub];
  if (!template) {
    return { kind: "message", text: `No prompt named "${sub}". See \`/prompt list\`.` };
  }
  const { vars } = parseArgs(parts.slice(1));
  return { kind: "run", prompt: expandTemplate(template, vars) };
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}
