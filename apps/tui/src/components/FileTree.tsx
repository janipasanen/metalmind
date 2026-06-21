import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".turbo", "target", ".venv", "__pycache__", ".metalmind",
]);

interface FileTreeProps {
  root: string;
  onClose: () => void;
  accent?: string;
}

interface VisibleRow {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
}

/** List a directory's entries (dirs first, then files; ignored dirs skipped). */
function listDir(dir: string): Array<{ name: string; isDir: boolean }> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as never;
  } catch {
    return [];
  }
  return entries
    .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

const MAX_ROWS = 18;

/**
 * Read-only terminal file browser (legacy #9). Arrow keys navigate; →/Enter
 * expands a directory, ← collapses (or jumps to parent), Esc closes.
 */
export default function FileTree({ root, onClose, accent = "cyan" }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [cursor, setCursor] = useState(0);

  // Flatten the expanded tree into a visible, indented row list.
  const rows = useMemo<VisibleRow[]>(() => {
    const out: VisibleRow[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of listDir(dir)) {
        const full = join(dir, entry.name);
        out.push({ path: full, name: entry.name, isDir: entry.isDir, depth });
        if (entry.isDir && expanded.has(full)) walk(full, depth + 1);
      }
    };
    out.push({ path: root, name: basename(root) || root, isDir: true, depth: 0 });
    if (expanded.has(root)) walk(root, 1);
    return out;
  }, [root, expanded]);

  const clampedCursor = Math.min(cursor, rows.length - 1);
  const current = rows[clampedCursor];

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.rightArrow || key.return || input === "l") {
      if (current?.isDir) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(current.path);
          return next;
        });
      }
    } else if (key.leftArrow || input === "h") {
      if (current?.isDir && expanded.has(current.path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(current.path);
          return next;
        });
      } else {
        // Jump to the parent row.
        const parentDepth = (current?.depth ?? 1) - 1;
        for (let i = clampedCursor - 1; i >= 0; i--) {
          if (rows[i].depth === parentDepth) {
            setCursor(i);
            break;
          }
        }
      }
    }
  });

  // Scroll window around the cursor.
  const start = Math.max(0, Math.min(clampedCursor - Math.floor(MAX_ROWS / 2), Math.max(0, rows.length - MAX_ROWS)));
  const view = rows.slice(start, start + MAX_ROWS);

  return (
    <Box borderStyle="round" borderColor={accent} flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold color={accent}>
        Files — ↑↓ move · →/Enter expand · ← collapse · Esc close
      </Text>
      {view.map((r, i) => {
        const selected = start + i === clampedCursor;
        const icon = r.isDir ? (expanded.has(r.path) ? "▾ " : "▸ ") : "  ";
        return (
          <Text key={r.path} inverse={selected} color={r.isDir ? accent : undefined}>
            {"  ".repeat(r.depth)}{icon}{r.name}{r.isDir ? "/" : ""}
          </Text>
        );
      })}
      {rows.length > MAX_ROWS && (
        <Text dimColor>
          {clampedCursor + 1}/{rows.length}
        </Text>
      )}
    </Box>
  );
}
