import { useState, useCallback, useRef } from "react";
import type { ChatMessage } from "../components/App.js";

export interface UseChatOptions {
  generateResponse: (input: string, signal?: AbortSignal) => AsyncGenerator<ChatStreamEvent>;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string } // live reasoning trace; shown dimmed, not saved as the answer
  | { type: "tool-call"; toolCall: { toolCallId?: string; toolName: string; argumentsJson: string } }
  | { type: "tool-result"; toolCallId?: string; output: string; diff?: string; filePath?: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function useChat(options: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<
    Array<{ toolName: string; argumentsJson: string; output?: string; diff?: string; filePath?: string }>
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
      setStreamingReasoning("");
      setActiveToolCalls([]);
      setIsStreaming(true);

      const abortController = new AbortController();
      abortRef.current = abortController;

      let assistantContent = "";
      let doneFired = false;
      const toolCalls: Array<{
        id: string;
        agentId?: string;
        toolName: string;
        argumentsJson: string;
        output?: string;
        diff?: string;
        filePath?: string;
      }> = [];

      try {

        // On abort we keep DRAINING: the agent ends promptly with a `done` that
        // commits the partial answer — breaking here discarded it (#286).
        for await (const event of options.generateResponse(userContent, abortController.signal)) {
          switch (event.type) {
            case "text":
              assistantContent += event.text;
              setStreamingContent(assistantContent);
              setStreamingReasoning(""); // answer started → drop the live reasoning
              break;

            case "reasoning":
              // Keep only a bounded tail so a long trace doesn't grow unbounded.
              setStreamingReasoning((prev) => (prev + event.text).slice(-2000));
              break;

            case "tool-call":
              toolCalls.push({
                id: `tc-${Date.now()}-${toolCalls.length}`,
                agentId: event.toolCall.toolCallId,
                toolName: event.toolCall.toolName,
                argumentsJson: event.toolCall.argumentsJson,
              });
              setActiveToolCalls([...toolCalls]);
              break;

            case "tool-result": {
              // Match by the agent's toolCallId; fall back to the first
              // unresolved call (results arrive in call order) (#285).
              const target =
                (event.toolCallId && toolCalls.find((tc) => tc.agentId === event.toolCallId)) ||
                toolCalls.find((tc) => tc.output === undefined) ||
                toolCalls[toolCalls.length - 1];
              if (target) {
                target.output = event.output;
                target.diff = event.diff;
                target.filePath = event.filePath;
                setActiveToolCalls([...toolCalls]);
              }
              break;
            }

            case "done": {
              doneFired = true;
              const assistantMsg: ChatMessage = {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: assistantContent,
                toolCalls: toolCalls.map((tc) => ({
                  id: tc.id,
                  toolName: tc.toolName,
                  argumentsJson: tc.argumentsJson,
                  output: tc.output,
                  diff: tc.diff,
                  filePath: tc.filePath,
                })),
                timestamp: new Date(),
              };
              setMessages((prev) => [...prev, assistantMsg]);
              setStreamingContent("");
              setStreamingReasoning("");
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
        // Safety net (#286): a cancelled/never-done stream still commits its
        // partial answer to the transcript instead of silently discarding it.
        // (Runs for BOTH the error path and a generator that ended without done.)
        if (!doneFired && (assistantContent || toolCalls.length > 0)) {
          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: assistantContent ? `${assistantContent}\n\n(cancelled)` : "(cancelled)",
              toolCalls: toolCalls.map((tc) => ({
                id: tc.id,
                toolName: tc.toolName,
                argumentsJson: tc.argumentsJson,
                output: tc.output,
                diff: tc.diff,
                filePath: tc.filePath,
              })),
              timestamp: new Date(),
            },
          ]);
        }
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingReasoning("");
        setActiveToolCalls([]);
        abortRef.current = null;
      }
    },
    [isStreaming, options],
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Replace the visible messages (used when resuming a persisted session). */
  const replaceMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
  }, []);

  return {
    messages,
    sendMessage,
    isStreaming,
    streamingContent,
    streamingReasoning,
    activeToolCalls,
    cancelStream,
    replaceMessages,
  };
}
