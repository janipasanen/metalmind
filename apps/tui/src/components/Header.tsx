import React from "react";
import { Text, Box } from "ink";

interface HeaderProps {
  projectName: string;
  modelName: string;
}

export default function Header({ projectName, modelName }: HeaderProps) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        Project:{" "}
      </Text>
      <Text>{truncate(projectName, 40)}</Text>
      <Text dimColor> │ Model: </Text>
      <Text color="yellow">{truncate(modelName, 30)}</Text>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
