import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export default function InputBar({ onSubmit, disabled = false }: InputBarProps) {
  const [value, setValue] = useState("");
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1); // -1 = not browsing history
  const draft = useRef("");      // saves current input while browsing

  useInput((_input, key) => {
    if (key.upArrow) {
      if (history.current.length === 0) return;
      if (historyIdx.current === -1) draft.current = value;
      historyIdx.current = Math.min(historyIdx.current + 1, history.current.length - 1);
      setValue(history.current[history.current.length - 1 - historyIdx.current]);
      return;
    }

    if (key.downArrow) {
      if (historyIdx.current === -1) return;
      historyIdx.current -= 1;
      setValue(historyIdx.current === -1 ? draft.current : history.current[history.current.length - 1 - historyIdx.current]);
      return;
    }
  }, { isActive: !disabled });

  const handleSubmit = useCallback(
    (text: string) => {
      if (disabled) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      // Avoid duplicate consecutive entries
      if (history.current[history.current.length - 1] !== trimmed) {
        history.current.push(trimmed);
      }
      historyIdx.current = -1;
      draft.current = "";
      onSubmit(trimmed);
      setValue("");
    },
    [onSubmit, disabled],
  );

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Box marginRight={1}>
        <Text color={disabled ? "gray" : "green"} bold>&gt;</Text>
      </Box>
      {disabled ? (
        <Text dimColor>… streaming response</Text>
      ) : (
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      )}
    </Box>
  );
}
