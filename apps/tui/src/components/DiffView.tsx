import React from "react";
import { Box, Text } from "ink";

interface DiffLine {
  text: string;
  type: "add" | "remove" | "context" | "header" | "info";
}

interface DiffViewProps {
  diff: string;
  filePath?: string;
  /** Cap on rendered diff lines (transcript uses a smaller cap than approvals). */
  maxLines?: number;
  /** Scroll offset in diff lines (approval view: j/k). */
  offset?: number;
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  // File headers appear ONLY at the top of a patch, before the first @@ hunk.
  // Without this flag, a deleted line whose content starts with `--` (a SQL or
  // Lua comment, a YAML document marker, an `---` markdown rule) or an added
  // line starting with `++` (a C increment) was classified as diff metadata and
  // rendered identically to it — a deletion looked like a header (#401).
  let inHunk = false;
  for (const line of raw.split("\n")) {
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      lines.push({ text: line, type: "header" });
    } else if (line.startsWith("@@")) {
      inHunk = true;
      lines.push({ text: line, type: "info" });
    } else if (line.startsWith("-")) {
      lines.push({ text: line, type: "remove" });
    } else if (line.startsWith("+")) {
      lines.push({ text: line, type: "add" });
    } else if (line.startsWith(" ")) {
      lines.push({ text: line, type: "context" });
    } else {
      lines.push({ text: line, type: "info" });
    }
  }
  return lines;
}

export default function DiffView({ diff, filePath, maxLines = 30, offset = 0 }: DiffViewProps) {
  if (!diff) {
    return (
      <Box padding={1}>
        <Text dimColor>No changes.</Text>
      </Box>
    );
  }

  const parsed = parseDiff(diff);
  // Top-anchored: the first hunk (where the edit almost always is) must be
  // visible; truncate from the TAIL with an explicit footer (#278).
  const start = Math.max(0, Math.min(offset, Math.max(0, parsed.length - maxLines)));
  const display = parsed.slice(start, start + maxLines);
  const hiddenAbove = start;
  const hidden = parsed.length - start - display.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {filePath ? (
        <Box marginBottom={1}>
          <Text bold color="yellow">
            {filePath}
          </Text>
        </Box>
      ) : null}

      {display.map((line, i) => (
        <Box key={i} flexDirection="row">
          <Text
            color={
              line.type === "add"
                ? "green"
                : line.type === "remove"
                  ? "red"
                  : line.type === "header"
                    ? "yellow"
                    : line.type === "info"
                      ? "cyan"
                      : undefined
            }
          >
            {line.text}
          </Text>
        </Box>
      ))}
      {hiddenAbove > 0 && <Text dimColor>↑ {hiddenAbove} line(s) above</Text>}
      {hidden > 0 && (
        <Text dimColor>… {hidden} more diff line(s) below</Text>
      )}
    </Box>
  );
}
