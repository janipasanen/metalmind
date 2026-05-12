import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  focusPanel: "chat" | "input";
}

export default function StatusBar({ focusPanel }: StatusBarProps) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        Tab: switch panels │ Ctrl+C: quit │ {focusPanel === "input" ? "Input" : "Chat"} active
      </Text>
    </Box>
  );
}
