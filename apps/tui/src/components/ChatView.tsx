import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "./App.js";

interface ChatViewProps {
  messages: ChatMessage[];
}

export default function ChatView({ messages }: ChatViewProps) {
  const visible = messages.slice(-15);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
      {visible.length === 0 && <Text dimColor>Chat is empty. Type a message below.</Text>}
      {visible.map((msg) => (
        <Box key={msg.id} flexDirection="row" marginBottom={0}>
          <Box width={10} flexShrink={0}>
            <Text
              color={msg.role === "user" ? "green" : msg.role === "system" ? "gray" : "cyan"}
              bold
            >
              {msg.role === "user" ? "You" : msg.role === "system" ? "System" : "AI"}
            </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={msg.role === "system" ? "gray" : undefined}>{msg.content}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
