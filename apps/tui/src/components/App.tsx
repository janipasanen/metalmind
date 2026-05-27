import React, { useState, useCallback } from "react";
import { Box, useInput } from "ink";
import Header from "./Header.js";
import ChatView from "./ChatView.js";
import InputBar from "./InputBar.js";
import StatusBar from "./StatusBar.js";
import { useChat } from "../hooks/useChat.js";
import type { TuiConfig } from "../config.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: Array<{
    id: string;
    toolName: string;
    argumentsJson: string;
    output?: string;
  }>;
  timestamp: Date;
}

interface AppProps {
  config: TuiConfig;
}

export default function App({ config }: AppProps) {
  const [activeModel, setActiveModel] = useState(`${config.provider}/${config.model}`);
  const [focusPanel, setFocusPanel] = useState<"chat" | "input">("input");
  const [projectName] = useState(() => {
    const parts = process.cwd().split("/");
    return parts[parts.length - 1] || "metalmind";
  });

  const { messages, sendMessage, isStreaming, streamingContent, activeToolCalls } = useChat({
    generateResponse: async function* (input: string) {
      if (input === "/help") {
        yield {
          type: "text",
          text: "Available commands:\n  /help - Show this help\n  /model <name> - Switch model\n  /clear - Clear chat\n  /quit - Exit",
        } as const;
      } else if (input === "/quit") {
        yield { type: "done" } as const;
        process.exit(0);
      } else if (input === "/clear") {
        yield { type: "done" } as const;
      } else if (input.startsWith("/model ")) {
        const newModel = input.slice(7).trim();
        setActiveModel(newModel);
        yield { type: "text", text: `Switched to model: ${newModel}` } as const;
      } else {
        yield { type: "text", text: `Response for: "${input}"` } as const;
      }
      yield { type: "done" } as const;
    },
  });

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  useInput((_input, key) => {
    if (key.tab) {
      setFocusPanel((prev) => (prev === "chat" ? "input" : "chat"));
    }
  });

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName={projectName} modelName={activeModel} />
      <ChatView
        messages={messages}
        streamingContent={streamingContent}
        activeToolCalls={activeToolCalls}
        isStreaming={isStreaming}
      />
      <InputBar onSubmit={handleSend} disabled={isStreaming} />
      <StatusBar focusPanel={focusPanel} isStreaming={isStreaming} />
    </Box>
  );
}
