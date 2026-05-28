import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

const SLASH_COMMANDS = [
  { syntax: "/help",        description: "Show available commands" },
  { syntax: "/model ",      description: "Switch model  e.g. /model gemma3:27b" },
  { syntax: "/apikey ",     description: "Update API key for current provider" },
  { syntax: "/workspace ",  description: "Allow AI to access a directory" },
  { syntax: "/clear",       description: "Clear chat history" },
  { syntax: "/quit",        description: "Exit" },
];

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  accent?: string;
}

export default function InputBar({ onSubmit, disabled = false, accent = "cyan" }: InputBarProps) {
  const [value, setValue] = useState("");
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const draft = useRef("");

  const filtered = value.startsWith("/")
    ? SLASH_COMMANDS.filter((c) => c.syntax.startsWith(value))
    : [];
  const showSuggestions = !disabled && filtered.length > 0;

  useInput((_input, key) => {
    if (showSuggestions) {
      if (key.upArrow) {
        setSuggestionIdx((p) => Math.max(p - 1, 0));
        return;
      }
      if (key.downArrow) {
        setSuggestionIdx((p) => Math.min(p + 1, filtered.length - 1));
        return;
      }
      if (key.tab) {
        setValue(filtered[suggestionIdx]?.syntax ?? value);
        setSuggestionIdx(0);
        return;
      }
      if (key.escape) {
        setValue("");
        setSuggestionIdx(0);
        return;
      }
      return; // swallow other special keys while suggestions open
    }

    // History navigation (only when suggestions are not open)
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

  const handleChange = (v: string) => {
    setValue(v);
    setSuggestionIdx(0);
    if (!v.startsWith("/")) historyIdx.current = -1;
  };

  const handleSubmit = useCallback(
    (text: string) => {
      if (disabled) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      if (history.current[history.current.length - 1] !== trimmed) {
        history.current.push(trimmed);
      }
      historyIdx.current = -1;
      draft.current = "";
      setSuggestionIdx(0);
      onSubmit(trimmed);
      setValue("");
    },
    [onSubmit, disabled],
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {showSuggestions && (
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} paddingY={0}>
          {filtered.map((cmd, i) => (
            <Box key={cmd.syntax} flexDirection="row">
              <Box width={2}>
                <Text color={i === suggestionIdx ? accent : "gray"}>{i === suggestionIdx ? ">" : " "}</Text>
              </Box>
              <Box width={14}>
                <Text color={i === suggestionIdx ? accent : "white"} bold={i === suggestionIdx}>
                  {cmd.syntax.trimEnd()}
                </Text>
              </Box>
              <Text dimColor>{cmd.description}</Text>
            </Box>
          ))}
          <Text dimColor>↑↓ select  Tab complete  Esc dismiss</Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Box marginRight={1}>
          <Text color={disabled ? "gray" : "green"} bold>&gt;</Text>
        </Box>
        {disabled ? (
          <Text dimColor>… streaming response</Text>
        ) : (
          <TextInput value={value} onChange={handleChange} onSubmit={handleSubmit} />
        )}
      </Box>
    </Box>
  );
}
