import React from "react";
import { Box, Text } from "ink";
import DiffView from "./DiffView.js";
import type { ApprovalRequest } from "../agent.js";

interface ApprovalViewProps {
  req: ApprovalRequest;
  accent?: string;
  /** Diff scroll offset controlled by App (j/k while the prompt is open). */
  diffScroll?: number;
}

/** Human-in-the-loop approval prompt for a side-effecting tool call (#138). */
export default function ApprovalView({ req, accent = "cyan", diffScroll = 0 }: ApprovalViewProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        ⚠ Approval required — {req.kind} action
      </Text>
      <Text>{req.summary}</Text>

      {req.command ? (
        <Box marginTop={1}>
          <Text color="cyan">$ {req.command}</Text>
        </Box>
      ) : null}

      {req.diff ? (
        <Box marginTop={1} flexDirection="column">
          <DiffView diff={req.diff} filePath={req.filePath ?? req.toolName} offset={diffScroll} />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={accent}>
          [y] approve once   [j/k] scroll diff   [a] always allow {req.filePath ? `“${req.toolName}” for ${req.filePath}` : req.command ? `this command` : `“${req.toolName}” for this target`} (session)   [n] reject (Esc)
        </Text>
      </Box>
    </Box>
  );
}
