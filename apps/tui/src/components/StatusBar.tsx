import React from "react";
import { Box, Text } from "ink";

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
}

interface StatusBarProps {
  focusPanel: "chat" | "input";
  isStreaming?: boolean;
  mcpServers?: McpServerStatus[];
  context?: { used: number; limit: number };
  usage?: { inputTokens: number; outputTokens: number };
  mode?: "build" | "plan";
  /** Per-prompt tier evaluation vs pinned cloud — shown so the current routing
   *  behaviour is always visible, not buried in a command. */
  evaluateEachPrompt?: boolean;
  /** A tier pinned with /tier, which overrides the evaluation setting. */
  forcedTier?: 1 | 2 | 3 | null;
}

export default function StatusBar({
  focusPanel,
  isStreaming = false,
  mcpServers,
  context,
  usage,
  mode = "build",
  evaluateEachPrompt = true,
  forcedTier = null,
}: StatusBarProps) {
  const connectedServers = mcpServers?.filter((s) => s.connected) ?? [];
  const totalMcpTools = connectedServers.reduce((sum, s) => sum + s.toolCount, 0);

  // Context-window gauge for the active model (#141).
  let ctxLabel = "";
  let ctxColor: string | undefined;
  if (context && context.limit > 0) {
    const pct = Math.min(100, Math.round((context.used / context.limit) * 100));
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
    ctxLabel = ` | ctx ${k(context.used)}/${k(context.limit)} (${pct}%)`;
    ctxColor = pct >= 90 ? "red" : pct >= 75 ? "yellow" : undefined;
  }

  // Session token usage meter (#157).
  let usageLabel = "";
  if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    usageLabel = ` | ↑${k(usage.inputTokens)} ↓${k(usage.outputTokens)}`;
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        {mode === "plan" ? <Text color="cyan" bold>PLAN </Text> : null}
        {/* Routing state, always visible (/routing to change). */}
        {forcedTier !== null ? (
          <Text color="yellow" bold>TIER {forcedTier} </Text>
        ) : (
          <Text color={evaluateEachPrompt ? "green" : "magenta"} bold>
            {evaluateEachPrompt ? "AUTO " : "CLOUD "}
          </Text>
        )}
        <Text dimColor>
          {isStreaming
            ? "Streaming | Esc: cancel | "
            : "Ctrl+P: commands | Tab: panels | Ctrl+C: quit | "}
          {focusPanel === "input" ? "Input" : "Chat"} active
        </Text>
        {ctxLabel ? <Text color={ctxColor} dimColor={!ctxColor}>{ctxLabel}</Text> : null}
        {usageLabel ? <Text dimColor>{usageLabel}</Text> : null}
      </Box>
      {connectedServers.length > 0 && (
        <Box>
          <Text dimColor>
            MCP: {connectedServers.map((s) => s.name).join(", ")}
            {totalMcpTools > 0 && ` (${totalMcpTools} tools)`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
