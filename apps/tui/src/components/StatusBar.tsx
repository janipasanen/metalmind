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
}

export default function StatusBar({
  focusPanel,
  isStreaming = false,
  mcpServers,
}: StatusBarProps) {
  const connectedServers = mcpServers?.filter((s) => s.connected) ?? [];
  const totalMcpTools = connectedServers.reduce((sum, s) => sum + s.toolCount, 0);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text dimColor>
          {isStreaming
            ? "Streaming | Esc: cancel | "
            : "Tab: switch panels | Ctrl+C: quit | "}
          {focusPanel === "input" ? "Input" : "Chat"} active
        </Text>
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
