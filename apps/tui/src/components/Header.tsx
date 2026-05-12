import React, { useState, useEffect } from "react";
import { Text, Box } from "ink";

export default function Header() {
  const [projectName, setProjectName] = useState("metalmind");

  useEffect(() => {
    const cwd = process.cwd();
    const parts = cwd.split("/");
    setProjectName(parts[parts.length - 1] || "metalmind");
  }, []);

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        Project:{" "}
      </Text>
      <Text>{projectName}</Text>
      <Text> </Text>
      <Text dimColor>| Model: local</Text>
    </Box>
  );
}
