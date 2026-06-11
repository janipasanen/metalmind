#!/usr/bin/env node
// Generate a Markdown changelog from Conventional Commits in a git range (#216).
// Usage: node scripts/changelog.mjs <range>   (e.g. v0.1.0..HEAD, or just HEAD)
import { execSync } from "node:child_process";

const range = process.argv[2] || "HEAD";

const GROUPS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactors"],
  ["docs", "Docs"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["chore", "Chores"],
];

function commits(range) {
  let raw = "";
  try {
    raw = execSync(`git log --no-merges --pretty=format:%s ${range}`, { encoding: "utf-8" });
  } catch {
    raw = execSync(`git log --no-merges --pretty=format:%s`, { encoding: "utf-8" });
  }
  return raw.split("\n").filter(Boolean);
}

export function buildChangelog(subjects) {
  const buckets = new Map(GROUPS.map(([k]) => [k, []]));
  const other = [];
  for (const s of subjects) {
    const m = s.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    if (m && buckets.has(m[1])) buckets.get(m[1]).push(m[2]);
    else other.push(s);
  }
  const out = [];
  for (const [key, title] of GROUPS) {
    const items = buckets.get(key);
    if (items.length) out.push(`### ${title}`, ...items.map((i) => `- ${i}`), "");
  }
  if (other.length) out.push("### Other", ...other.map((i) => `- ${i}`), "");
  return out.join("\n").trim() || "_No notable changes._";
}

// Only emit when run directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(buildChangelog(commits(range)) + "\n");
}
