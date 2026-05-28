import React from "react";
import { Text, Box } from "ink";

interface HeaderProps {
  projectName: string;
  modelName: string;
  accent?: string;
}

export default function Header({ projectName, modelName, accent = "cyan" }: HeaderProps) {
  const displayModel = modelName.includes("/") && modelName.includes("models")
    ? modelName.split("/").pop() || modelName
    : modelName;

  return (
    <Box borderStyle="round" borderColor={accent} paddingX={1} marginBottom={1} width="100%">
      <Box flexShrink={0}>
        <Text bold color={accent}>
          Project:{" "}
        </Text>
        <Text>{truncate(projectName, 30)}</Text>
      </Box>
      <Text dimColor> │ </Text>
      <Box flexGrow={1}>
        <Text dimColor>Model: </Text>
        <Text color="yellow">{truncate(displayModel, 120)}</Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
