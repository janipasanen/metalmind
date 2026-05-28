import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput } from "ink";

export interface Command {
  id: string;
  title: string;
  description: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
  accent?: string;
}

export default function CommandPalette({ isOpen, onClose, commands, accent = "cyan" }: CommandPaletteProps) {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredCommands = commands.filter(
    (cmd) => cmd.title.toLowerCase().includes(filter.toLowerCase()) || cmd.description.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (key.return) {
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].action();
        onClose();
      }
      return;
    }

    if (key.backspace) {
      setFilter((prev) => prev.slice(0, -1));
      return;
    }

    if (input) {
      setFilter((prev) => prev + input);
    }
  });

  if (!isOpen) return null;

  return (
    <Box
      flexDirection="column"
      borderColor={accent}
      paddingX={1}
      paddingY={1}
      width="80%"
    >
      <Text dimColor>Search commands... (Esc to close)</Text>
      <Text>{filter}</Text>
      <Box flexDirection="column" paddingY={1}>
        {filteredCommands.length === 0 ? (
          <Text dimColor>No commands found</Text>
        ) : (
          filteredCommands.map((cmd, i) => (
            <Box key={cmd.id} flexDirection="row" marginRight={1}>
              <Box width={3}>
                <Text color={i === selectedIndex ? accent : "gray"}>{i === selectedIndex ? ">" : " "}</Text>
              </Box>
              <Text>{cmd.title}</Text>
              <Box flexGrow={1} />
              <Text dimColor>{cmd.description}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
