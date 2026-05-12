import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  onSubmit: (text: string) => void;
}

export default function InputBar({ onSubmit }: InputBarProps) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setValue("");
      }
    },
    [onSubmit],
  );

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Box marginRight={1}>
        <Text color="green" bold>
          &gt;
        </Text>
      </Box>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
