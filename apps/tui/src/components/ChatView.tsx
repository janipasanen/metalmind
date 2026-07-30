import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "./App.js";
import MarkdownText from "./MarkdownText.js";
import DiffView from "./DiffView.js";
import { pageWindow } from "../paging.js";

interface ChatViewProps {
  messages: ChatMessage[];
  streamingContent: string;
  activeToolCalls: Array<{
    toolName: string;
    argumentsJson: string;
    output?: string;
    diff?: string;
    filePath?: string;
  }>;
  isStreaming: boolean;
  accent?: string;
  /** Messages scrolled up from the live tail (#159). */
  scrollOffset?: number;
  /** How many messages fit on screen (#159). */
  pageSize?: number;
}

const roleLabel: Record<string, string> = {
  user: "You",
  assistant: "AI",
  system: "System",
};

function truncateJson(json: string, max = 60): string {
  if (json.length <= max) return json;
  return json.slice(0, max - 3) + "...";
}

/** One completed history message. Memoized (#339): streaming re-renders the view
 *  on every token, and re-rendering (and re-parsing markdown for) the whole
 *  scrollback each time makes long sessions visibly sluggish. Message objects
 *  are append-only and never mutated (useChat builds fresh objects), so
 *  reference equality is the correct bail-out. */
const HistoryMessage = React.memo(function HistoryMessage({ msg, accent }: { msg: ChatMessage; accent: string }) {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box flexDirection="row">
        <Box width={8} flexShrink={0}>
          <Text color={msg.role === "user" ? "green" : msg.role === "system" ? "gray" : accent} bold>
            {roleLabel[msg.role] ?? msg.role}
          </Text>
        </Box>
        <Box flexGrow={1}>
          {msg.role === "assistant"
            ? <MarkdownText text={msg.content} accent={accent} />
            : <Text color={msg.role === "system" ? "gray" : undefined}>{msg.content}</Text>}
        </Box>
      </Box>
      {msg.toolCalls?.length ? (
        msg.toolCalls.map((tc) => (
          <Box key={tc.id} marginLeft={8} flexDirection="column">
            <Box>
              <Text color="yellow" dimColor>
                ↳ {tc.toolName}({truncateJson(tc.argumentsJson)})
              </Text>
            </Box>
            {tc.diff ? (
              <Box marginLeft={2} flexDirection="column">
                <DiffView diff={tc.diff} filePath={tc.filePath} maxLines={12} />
              </Box>
            ) : tc.output ? (
              <Box marginLeft={2}>
                <Text color="green" dimColor>
                  ← {truncateJson(tc.output, 200)}
                </Text>
              </Box>
            ) : null}
          </Box>
        ))
      ) : null}
    </Box>
  );
});

export default function ChatView({
  messages,
  streamingContent,
  activeToolCalls,
  isStreaming,
  accent = "cyan",
  scrollOffset = 0,
  pageSize = 12,
}: ChatViewProps) {
  const win = pageWindow(messages.length, scrollOffset, pageSize);
  const visibleMessages = messages.slice(win.start, win.end);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
      {visibleMessages.length === 0 && !isStreaming && (
        <Text dimColor>Welcome to Metalmind. Type a message below.</Text>
      )}

      {win.hiddenAbove > 0 && (
        <Text dimColor>↑ {win.hiddenAbove} earlier message{win.hiddenAbove === 1 ? "" : "s"} (PgUp/PgDn to scroll)</Text>
      )}

      {visibleMessages.map((msg) => (
        <HistoryMessage key={msg.id} msg={msg} accent={accent} />
      ))}

      {win.hiddenBelow > 0 && (
        <Text dimColor>↓ {win.hiddenBelow} newer message{win.hiddenBelow === 1 ? "" : "s"} (PgDn / End to jump to latest)</Text>
      )}

      {isStreaming && streamingContent ? (
        <Box flexDirection="row" marginBottom={0}>
          <Box width={8} flexShrink={0}>
            <Text color={accent} bold>AI</Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            <MarkdownText text={streamingContent} accent={accent} />
            {/* Tool activity stays visible even after text has streamed (#298). */}
            {activeToolCalls.length > 0 && (
              <Box flexDirection="column">
                {activeToolCalls.slice(-4).map((tc, i) => (
                  <Text key={i} color="yellow" dimColor>
                    {tc.output ? "✓" : "…"} {tc.toolName}({truncateJson(tc.argumentsJson)})
                  </Text>
                ))}
                {activeToolCalls.length > 4 && (
                  <Text dimColor>({activeToolCalls.filter((t) => t.output).length} of {activeToolCalls.length} tools done)</Text>
                )}
              </Box>
            )}
            <Text color="yellow" dimColor>▌</Text>
          </Box>
        </Box>
      ) : null}

      {isStreaming && !streamingContent && activeToolCalls.length > 0 ? (
        <Box flexDirection="row">
          <Box width={8} flexShrink={0}>
            <Text color={accent} bold>AI</Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {activeToolCalls.map((tc, i) => (
              <Box key={i}>
                <Text color="yellow">
                  {tc.output ? "✓" : "…"} {tc.toolName}({truncateJson(tc.argumentsJson)})
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}

      {isStreaming && !streamingContent && activeToolCalls.length === 0 ? (
        <Box flexDirection="row">
          <Box width={8} flexShrink={0}>
            <Text color={accent} bold>AI</Text>
          </Box>
          <Box flexGrow={1}>
            <Text color="yellow" dimColor>… thinking</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
