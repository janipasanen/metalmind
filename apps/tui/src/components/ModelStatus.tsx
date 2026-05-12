import React from "react";
import { Box, Text } from "ink";

interface ModelStatusProps {
  modelName: string;
  provider: string;
  tier: string;
  reason: string;
  costUsd?: number;
  latencyMs?: number;
  escalatedFrom?: string;
}

export default function ModelStatus({
  modelName,
  provider,
  tier,
  reason,
  costUsd,
  latencyMs,
  escalatedFrom,
}: ModelStatusProps) {
  const tierColor = tier === "tier3-cloud" ? "magenta" : tier === "tier2-medium" ? "yellow" : "green";

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text bold color={tierColor}>
          [{tier}]
        </Text>
        <Text> </Text>
        <Text>
          {provider}/{modelName}
        </Text>
      </Box>

      {escalatedFrom ? (
        <Box>
          <Text color="yellow" dimColor>
            ⬆ Escalated from {escalatedFrom}
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text dimColor>{reason}</Text>
      </Box>

      {(costUsd !== undefined || latencyMs !== undefined) ? (
        <Box>
          {latencyMs !== undefined ? (
            <Text dimColor>{latencyMs}ms</Text>
          ) : null}
          {costUsd !== undefined && costUsd > 0 ? (
            <Text dimColor>
              {latencyMs !== undefined ? " | " : ""}${costUsd.toFixed(4)}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
