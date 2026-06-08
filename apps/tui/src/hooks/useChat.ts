import { useState, useCallback, useRef } from "react";
import type { ChatMessage } from "../components/App.js";

export interface UseChatOptions {
  generateResponse: (input: string, signal?: AbortSignal) => AsyncGenerator<ChatStreamEvent>;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCall: { toolName: string; argumentsJson: string } }
  | { type: "tool-result"; output: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function useChat(options: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<
    Array<{ toolName: string; argumentsJson: string; output?: string }>
  >([]);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (userContent: string) => {
      if (!userContent.trim() || isStreaming) return;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: userContent.trim(),
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setStreamingContent("");
      setActiveToolCalls([]);
      setIsStreaming(true);

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        let assistantContent = "";
        const toolCalls: Array<{
          id: string;
          toolName: string;
          argumentsJson: string;
          output?: string;
        }> = [];

        for await (const event of options.generateResponse(userContent, abortController.signal)) {
          if (abortController.signal.aborted) break;

          switch (event.type) {
            case "text":
              assistantContent += event.text;
              setStreamingContent(assistantContent);
              break;

            case "tool-call":
              toolCalls.push({
                id: `tc-${Date.now()}-${toolCalls.length}`,
                toolName: event.toolCall.toolName,
                argumentsJson: event.toolCall.argumentsJson,
              });
              setActiveToolCalls([...toolCalls]);
              break;

            case "tool-result": {
              const lastCall = toolCalls[toolCalls.length - 1];
              if (lastCall) {
                lastCall.output = event.output;
                setActiveToolCalls([...toolCalls]);
              }
              break;
            }

            case "done": {
              const assistantMsg: ChatMessage = {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: assistantContent,
                toolCalls: toolCalls.map((tc) => ({
                  id: tc.id,
                  toolName: tc.toolName,
                  argumentsJson: tc.argumentsJson,
                  output: tc.output,
                })),
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, assistantMsg]);
              setStreamingContent("");
              setActiveToolCalls([]);
              break;
            }

            case "error":
              setMessages((prev) => [
                ...prev,
                {
                  id: `error-${Date.now()}`,
                  role: "system",
                  content: `Error: ${event.message}`,
                  timestamp: new Date(),
                },
              ]);
              break;
          }
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "system",
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsStreaming(false);
        setStreamingContent("");
        abortRef.current = null;
      }
    },
    [isStreaming, options],
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    sendMessage,
    isStreaming,
    streamingContent,
    activeToolCalls,
    cancelStream,
  };
}
