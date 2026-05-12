import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "./App.js";

interface ChatViewProps {
  messages: ChatMessage[];
  streamingContent: string;
  activeToolCalls: Array<{
    toolName: string;
    argumentsJson: string;
    output?: string;
  }>;
  isStreaming: boolean;
}

const roleColor: Record<string, string> = {
  user: "green",
  assistant: "cyan",
  system: "gray",
};

const roleLabel: Record<string, string> = {
  user: "You",
  assistant: "AI",
  system: "System",
};

function truncateJson(json: string, max = 60): string {
  if (json.length <= max) return json;
  return json.slice(0, max - 3) + "...";
}

export default function ChatView({
  messages,
  streamingContent,
  activeToolCalls,
  isStreaming,
}: ChatViewProps) {
  const visibleMessages = messages.slice(-12);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexGrow={1}
    >
      {visibleMessages.length === 0 &&
        !isStreaming && (
          <Text dimColor>Welcome to Metalmind. Type a message below.</Text>
        )}

      {visibleMessages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={0}>
          <Box flexDirection="row">
            <Box width={8} flexShrink={0}>
              <Text color={roleColor[msg.role] ?? "white"} bold>
                {roleLabel[msg.role] ?? msg.role}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={msg.role === "system" ? "gray" : undefined}>
                {msg.content}
              </Text>
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
                {tc.output ? (
                  <Box marginLeft={2}>
                    <Text color="green" dimColor>
                      ← {truncateJson(tc.output, 80)}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            ))
          ) : null}
        </Box>
      ))}

      {isStreaming && streamingContent ? (
        <Box flexDirection="row" marginBottom={0}>
          <Box width={8} flexShrink={0}>
            <Text color="cyan" bold>
              AI
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color="cyan">{streamingContent}</Text>
            <Text color="yellow" dimColor>
              ▌
            </Text>
          </Box>
        </Box>
      ) : null}

      {isStreaming && !streamingContent && activeToolCalls.length > 0 ? (
        <Box flexDirection="row">
          <Box width={8} flexShrink={0}>
            <Text color="cyan" bold>
              AI
            </Text>
          </Box>
          <Box flexGrow={1} flexDirection="column">
            {activeToolCalls.map((tc, i) => (
              <Box key={i}>
                <Text color="yellow">
                  {tc.output ? "✓" : "…"} {tc.toolName}(
                  {truncateJson(tc.argumentsJson)})
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}

      {isStreaming && !streamingContent && activeToolCalls.length === 0 ? (
        <Box flexDirection="row">
          <Box width={8} flexShrink={0}>
            <Text color="cyan" bold>
              AI
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color="yellow" dimColor>
              … thinking
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
