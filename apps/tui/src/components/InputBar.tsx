import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { parseBracketedPaste, endsWithContinuation, applyContinuation } from "../multiline.js";
import { vimKey, initialVimState } from "../vim.js";

const SLASH_COMMANDS = [
  { syntax: "/help",        description: "Show available commands" },
  { syntax: "/tier ",       description: "Force a tier: 1|2|3|auto [model]" },
  { syntax: "/cost",        description: "Show this session's token usage" },
  { syntax: "/budget ",     description: "View or set the session spend cap" },
  { syntax: "/routes",      description: "Routing decisions + per-tier counts" },
  { syntax: "/brain ",      description: "Remote-brain mode: on|off (cloud delegates to local)" },
  { syntax: "/keychain ",   description: "save/load/status — macOS keychain" },
  { syntax: "/model ",      description: "Switch model  e.g. /model gemma3:27b" },
  { syntax: "/models ",     description: "Manage local models: list|pull <n>|delete <n>" },
  { syntax: "/apikey ",     description: "Update API key for current provider" },
  { syntax: "/workspace ",  description: "Allow AI to access a directory" },
  { syntax: "/init",        description: "Generate a starter project memory file" },
  { syntax: "/skill ",      description: "list / activate / deactivate skills" },
  { syntax: "/prompt ",     description: "Prompt library: save|list|delete|<name>" },
  { syntax: "/image ",      description: "Attach an image for a vision model" },
  { syntax: "/rag ",        description: "Document retrieval: add|search|status|clear" },
  { syntax: "/remember ",   description: "Save a durable fact to long-term memory" },
  { syntax: "/allow ",      description: "Persist auto-approval: tool|path|command" },
  { syntax: "/mcp ",        description: "MCP servers: list|presets|add|remove" },
  { syntax: "/resume",      description: "List or resume a saved session" },
  { syntax: "/compact",     description: "Summarize older turns to save context" },
  { syntax: "/export ",     description: "Export transcript (md|json)" },
  { syntax: "/retry",       description: "Re-run the last prompt" },
  { syntax: "/edit ",       description: "Edit + re-run the last prompt" },
  { syntax: "/branch",      description: "Fork this conversation into a new session" },
  { syntax: "/copy ",       description: "Copy last message or code to clipboard" },
  { syntax: "/undo",        description: "Revert the agent's last edit set" },
  { syntax: "/redo",        description: "Re-apply the last undone edit set" },
  { syntax: "/audit",       description: "Show this session's tool-call log" },
  { syntax: "/diagnostics", description: "Show recent errors / crash log" },
  { syntax: "/vim ",        description: "Toggle vim modal editing (on|off|help)" },
  { syntax: "/clear",       description: "Clear chat history" },
  { syntax: "/quit",        description: "Exit" },
];

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  accent?: string;
  /** Vim modal editing in the input bar (#184). */
  vimMode?: boolean;
}

export default function InputBar({ onSubmit, disabled = false, accent = "cyan", vimMode = false }: InputBarProps) {
  const [value, setValue] = useState("");
  const [vim, setVim] = useState(() => initialVimState(""));
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const draft = useRef("");

  const filtered = value.startsWith("/")
    ? SLASH_COMMANDS.filter((c) => c.syntax.startsWith(value))
    : [];
  const showSuggestions = !disabled && filtered.length > 0;

  useInput((_input, key) => {
    // Vim modal editing drives the buffer when enabled and no slash menu is open (#184).
    if (vimMode && !showSuggestions) {
      const r = vimKey(vim, _input, key);
      if (r.submit) {
        handleSubmit(vim.value);
        setVim(initialVimState(""));
      } else {
        setVim(r.state);
        setValue(r.state.value);
      }
      return;
    }
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
    // Strip bracketed-paste markers; multi-line pastes stay in the buffer (#160).
    const { text } = parseBracketedPaste(v);
    setValue(text);
    setSuggestionIdx(0);
    if (!text.startsWith("/")) historyIdx.current = -1;
  };

  const handleSubmit = useCallback(
    (text: string) => {
      if (disabled) return;
      // A line ending in a single backslash continues onto the next line (#160).
      if (endsWithContinuation(text)) {
        setValue(applyContinuation(text));
        return;
      }
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
      {value.includes("\n") && (
        <Box flexDirection="column" paddingLeft={2}>
          {value.split("\n").slice(0, -1).map((l, i) => (
            <Text key={i} dimColor>{l || " "}</Text>
          ))}
        </Box>
      )}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Box marginRight={1}>
          {vimMode && !disabled ? (
            <Text color={vim.mode === "insert" ? "green" : "yellow"} bold>[{vim.mode === "insert" ? "I" : "N"}]</Text>
          ) : (
            <Text color={disabled ? "gray" : "green"} bold>{value.includes("\n") ? "…" : ">"}</Text>
          )}
        </Box>
        {disabled ? (
          <Text dimColor>… streaming response</Text>
        ) : vimMode ? (
          <Text>
            {value.slice(0, vim.cursor)}
            <Text inverse>{value[vim.cursor] ?? " "}</Text>
            {value.slice(vim.cursor + 1)}
          </Text>
        ) : (
          <TextInput
            value={value.includes("\n") ? value.slice(value.lastIndexOf("\n") + 1) : value}
            onChange={(v) => handleChange(value.includes("\n") ? value.slice(0, value.lastIndexOf("\n") + 1) + v : v)}
            onSubmit={() => handleSubmit(value)}
          />
        )}
      </Box>
    </Box>
  );
}
