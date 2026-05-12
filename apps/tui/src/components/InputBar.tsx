import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSubmit, disabled = false }: InputBarProps) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (text: string) => {
      if (disabled) return;
      const trimmed = text.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setValue("");
      }
    },
    [onSubmit, disabled],
  );

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Box marginRight={1}>
        <Text color={disabled ? "gray" : "green"} bold>
          &gt;
        </Text>
      </Box>
      {disabled ? (
        <Text dimColor>… streaming response</Text>
      ) : (
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      )}
    </Box>
  );
}
