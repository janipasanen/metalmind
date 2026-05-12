import React from "react";
import { Box, Text } from "ink";

interface DiffLine {
  text: string;
  type: "add" | "remove" | "context" | "header" | "info";
}

interface DiffViewProps {
  diff: string;
  filePath?: string;
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      lines.push({ text: line, type: "header" });
    } else if (line.startsWith("@@")) {
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

export default function DiffView({ diff, filePath }: DiffViewProps) {
  if (!diff) {
    return (
      <Box padding={1}>
        <Text dimColor>No changes.</Text>
      </Box>
    );
  }

  const parsed = parseDiff(diff);
  const display = parsed.slice(-30);

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
    </Box>
  );
}
