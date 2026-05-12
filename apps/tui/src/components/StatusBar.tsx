import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  focusPanel: "chat" | "input";
  isStreaming?: boolean;
}

export default function StatusBar({ focusPanel, isStreaming = false }: StatusBarProps) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {isStreaming
          ? "Streaming | Esc: cancel | "
          : "Tab: switch panels | Ctrl+C: quit | "}
        {focusPanel === "input" ? "Input" : "Chat"} active
      </Text>
    </Box>
  );
}
