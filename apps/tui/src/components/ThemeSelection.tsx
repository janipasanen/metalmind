import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { themes } from "@metalmind/config";

interface ThemeSelectionProps {
  currentTheme: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

export default function ThemeSelection({ currentTheme, onSelect, onCancel }: ThemeSelectionProps) {
  const [selectedIndex, setSelectedIndex] = useState(themes.findIndex(t => t.id === currentTheme));

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, themes.length - 1));
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }
    if (key.return) {
      onSelect(themes[selectedIndex].id);
    }
  });

  return (
    <Box flexDirection="column" borderColor="cyan" paddingX={1} paddingY={1} width="60%">
      <Text bold color="cyan">Select Theme</Text>
      <Box flexDirection="column" paddingY={1}>
        {themes.map((theme, i) => (
          <Box key={theme.id} flexDirection="row" marginRight={1}>
            <Box width={3}>
              <Text color={i === selectedIndex ? "cyan" : "gray"}>
                {i === selectedIndex ? ">" : " "}
              </Text>
            </Box>
            <Text>{theme.name}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>
        Arrow keys to navigate, Return to select, Esc to cancel
      </Text>
    </Box>
  );
}
