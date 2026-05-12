import React, { useState, useCallback } from "react";
import { Box, useInput } from "ink";
import Header from "./Header.js";
import ChatView from "./ChatView.js";
import InputBar from "./InputBar.js";
import StatusBar from "./StatusBar.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      content: "Welcome to Metalmind. Type /help for commands.",
      timestamp: new Date(),
    },
  ]);
  const [modelName, setModelName] = useState("ollama/deepseek-coder:1.3b");
  const [focusPanel, setFocusPanel] = useState<"chat" | "input">("input");
  const [projectName] = useState(() => {
    const parts = process.cwd().split("/");
    return parts[parts.length - 1] || "metalmind";
  });

  const handleSend = useCallback(
    (text: string) => {
      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      if (text.startsWith("/model ")) {
        const newModel = text.slice(7).trim();
        setModelName(newModel);
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}`,
            role: "system",
            content: `Switched to model: ${newModel}`,
            timestamp: new Date(),
          },
        ]);
      } else if (text === "/help") {
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}`,
            role: "system",
            content: `Available commands:\n  /help - Show this help\n  /model <name> - Switch model\n  /clear - Clear chat\n  /quit - Exit`,
            timestamp: new Date(),
          },
        ]);
      } else if (text === "/clear") {
        setMessages([]);
      } else if (text === "/quit") {
        process.exit(0);
      }
    },
    [],
  );

  useInput((input, key) => {
    if (key.tab) {
      setFocusPanel((prev) => (prev === "chat" ? "input" : "chat"));
    }
  });

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName={projectName} modelName={modelName} />
      <ChatView messages={messages} />
      <InputBar onSubmit={handleSend} />
      <StatusBar focusPanel={focusPanel} />
    </Box>
  );
}
