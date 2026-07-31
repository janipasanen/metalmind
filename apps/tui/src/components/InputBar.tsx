import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { parseBracketedPaste, endsWithContinuation, applyContinuation } from "../multiline.js";
import { vimKey, initialVimState } from "../vim.js";
import { formatMention } from "../mentions.js";
import { readdirSync } from "node:fs";
import { loadUserCommands, type UserCommand } from "../user-commands.js";
import { join } from "node:path";

const PATH_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", "target", ".venv", "__pycache__", ".metalmind"]);
const PATH_CAP = 2000;

/** Bounded project file walk for @-path completion (#277). */
function walkProjectPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length >= PATH_CAP) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= PATH_CAP) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!PATH_IGNORE_DIRS.has(e.name)) walk(join(dir, e.name), r);
      } else {
        out.push(r);
      }
    }
  };
  walk(root, "");
  return out;
}

const SLASH_COMMANDS = [
  { syntax: "/help",        description: "Show available commands" },
  { syntax: "/plan",        description: "Plan mode: read-only, proposes a plan" },
  { syntax: "/build",       description: "Build mode: executes changes (default)" },
  { syntax: "/commit ",     description: "Stage + AI-generated Conventional Commit" },
  { syntax: "/pr ",         description: "Push branch + create a GitHub PR (gh)" },
  { syntax: "/test ",       description: "Run tests; result feeds the model" },
  { syntax: "/check",       description: "Run the project check (tsc/config)" },
  { syntax: "/lint ",       description: "Run the linter; result feeds the model" },
  { syntax: "/tree",        description: "Browse project files" },
  { syntax: "/notifications", description: "Show recent notifications" },
  { syntax: "/doctor",      description: "Diagnose environment (ollama, keys, CLIs)" },
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
  { syntax: "/trust ",      description: "Review/grant project startup hooks & servers" },
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
  { syntax: "/copy ",       description: "Copy last|code|all|<n> to clipboard" },
  { syntax: "/search ",     description: "Find text in this conversation" },
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
  /** Project root for @-path completion (#277). */
  projectRoot?: string;
  /** External text insertion (e.g. FileTree Enter → @mention) (#299). */
  insertText?: { text: string; nonce: number } | null;
}

export default function InputBar({ onSubmit, disabled = false, accent = "cyan", vimMode = false, projectRoot, insertText }: InputBarProps) {
  const [value, setValue] = useState("");
  const [vim, setVim] = useState(() => initialVimState(""));
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const draft = useRef("");
  // Set when a Ctrl/Alt chord was claimed, so the edit ink-text-input makes for
  // that same keystroke is discarded instead of typing the chord letter (#385).
  const suppressChange = useRef(false);

  const pathsRef = useRef<string[] | null>(null);

  // External insertion (#299): append e.g. "@src/a.ts " when the nonce changes.
  const lastNonce = useRef(-1);
  useEffect(() => {
    if (insertText && insertText.nonce !== lastNonce.current) {
      lastNonce.current = insertText.nonce;
      setValue((v) => {
        const next = (v.endsWith(" ") || v === "" ? v : v + " ") + insertText.text;
        // Keep the vim buffer in sync — it renders its own value, so without
        // this the inserted mention would be invisible in vim mode.
        if (vimMode) setVim(initialVimState(next));
        return next;
      });
    }
  }, [insertText, vimMode]);

  const [dismissed, setDismissed] = useState(false);
  const wasAtMatch = useRef(false);

  // User-defined commands join the autocomplete; reloaded when the "/" popup
  // (re)opens so newly created files appear without a restart.
  const userCmdsRef = useRef<UserCommand[] | null>(null);
  const wasSlash = useRef(false);
  const isSlash = value.startsWith("/");
  if (isSlash && (!wasSlash.current || userCmdsRef.current === null)) {
    userCmdsRef.current = projectRoot ? loadUserCommands(projectRoot) : [];
  }
  wasSlash.current = isSlash;
  const slashMatches = isSlash
    ? [
        ...SLASH_COMMANDS.filter((c) => c.syntax.startsWith(value)),
        ...(userCmdsRef.current ?? [])
          .filter((c) => `/${c.name}`.startsWith(value.split(" ")[0]))
          .map((c) => ({ syntax: `/${c.name} `, description: `(custom) ${c.description}` })),
      ]
    : [];
  // @-path completion (#277): complete the trailing @token against the project tree.
  const atMatch = !value.startsWith("/") && projectRoot ? /@([A-Za-z0-9_./-]*)$/.exec(value) : null;
  let pathMatches: string[] = [];
  if (atMatch) {
    // Rebuild the path cache each time a NEW @-token starts, so files the agent
    // just created/deleted show up (a per-process cache went stale immediately).
    if (pathsRef.current === null || !wasAtMatch.current) pathsRef.current = walkProjectPaths(projectRoot!);
    const q = atMatch[1].toLowerCase();
    pathMatches = pathsRef.current.filter((pp) => pp.toLowerCase().includes(q)).slice(0, 8);
  }
  wasAtMatch.current = atMatch !== null;
  const suggestions: Array<{ label: string; description: string }> = atMatch
    // Quote paths with spaces so the mention parser keeps them whole (#386).
    ? pathMatches.map((pp) => ({ label: formatMention(pp), description: "" }))
    : slashMatches.map((c) => ({ label: c.syntax, description: c.description }));
  const filtered = suggestions;
  const showSuggestions = !disabled && filtered.length > 0 && !dismissed;

  const acceptSuggestion = (idx: number) => {
    const sel = filtered[idx];
    if (!sel) return;
    const next = atMatch ? value.slice(0, atMatch.index) + sel.label + " " : sel.label;
    setValue(next);
    // Vim renders its own buffer — keep it in sync or the completion would be
    // invisibly reverted by the next vim keystroke.
    if (vimMode) setVim(initialVimState(next));
    setSuggestionIdx(0);
  };

  useInput((_input, key) => {
    // Modifier chords (Ctrl+P palette, Ctrl+O panel, Ctrl+U/W …) are app
    // shortcuts. ink-text-input only filters Ctrl+C, so every OTHER chord used
    // to be inserted into the buffer as a bare letter. Claim them here and tell
    // handleChange to discard the edit TextInput is about to make (#385).
    if (key.ctrl || key.meta) {
      suppressChange.current = true;
      return;
    }
    suppressChange.current = false;

    // Suggestion navigation claims ONLY its nav keys; every other key falls
    // through so typing keeps working. (Previously the open menu swallowed all
    // keys, which froze the input entirely in vim mode — no TextInput is
    // mounted there, so the vim branch was the only way characters got in.)
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
        acceptSuggestion(suggestionIdx);
        return;
      }
      if (key.escape && !vimMode) {
        // Dismiss the popup but KEEP the draft — wiping a 30-char sentence
        // because a path popup auto-opened mid-word was destructive. The flag
        // resets on the next text change.
        setDismissed(true);
        setSuggestionIdx(0);
        return;
      }
    }

    // Vim modal editing drives the buffer when enabled (#184).
    if (vimMode) {
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

    // History navigation (only when suggestions are not open)
    if (showSuggestions) return;
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
    // The keystroke was a Ctrl/Alt chord claimed above — drop TextInput's edit
    // instead of letting the chord's letter land in the buffer (#385).
    if (suppressChange.current) {
      suppressChange.current = false;
      return;
    }
    // Strip bracketed-paste markers; multi-line pastes stay in the buffer (#160).
    const { text } = parseBracketedPaste(v);
    setValue(text);
    setSuggestionIdx(0);
    setDismissed(false);
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
            <Box key={cmd.label} flexDirection="row">
              <Box width={2}>
                <Text color={i === suggestionIdx ? accent : "gray"}>{i === suggestionIdx ? ">" : " "}</Text>
              </Box>
              <Box width={cmd.description ? 14 : undefined}>
                <Text color={i === suggestionIdx ? accent : "white"} bold={i === suggestionIdx}>
                  {cmd.label.trimEnd()}
                </Text>
              </Box>
              {cmd.description ? <Text dimColor>{cmd.description}</Text> : null}
            </Box>
          ))}
          <Text dimColor>↑↓ select  Tab complete  Esc dismiss</Text>
        </Box>
      )}
      {value.includes("\n") && (() => {
        // Cap the preview (#372): a 300-line paste rendered 300 screen rows,
        // blowing past the terminal height and forcing Ink to clear and repaint
        // the WHOLE screen on every keystroke. Show a head/tail window with a
        // count of what's hidden — the full text is still sent on Enter.
        const lines = value.split("\n").slice(0, -1);
        const MAX = 8;
        const shown =
          lines.length <= MAX
            ? lines.map((l, i) => ({ key: `l${i}`, text: l || " " }))
            : [
                ...lines.slice(0, MAX - 3).map((l, i) => ({ key: `h${i}`, text: l || " " })),
                { key: "gap", text: `… ${lines.length - (MAX - 1)} more lines …` },
                ...lines.slice(-2).map((l, i) => ({ key: `t${i}`, text: l || " " })),
              ];
        return (
          <Box flexDirection="column" paddingLeft={2}>
            {shown.map((l) => (
              <Text key={l.key} dimColor wrap="truncate-end">{l.text}</Text>
            ))}
            {lines.length > MAX && (
              <Text dimColor italic>({lines.length + 1} lines pasted — Enter sends all of it)</Text>
            )}
          </Box>
        );
      })()}
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
