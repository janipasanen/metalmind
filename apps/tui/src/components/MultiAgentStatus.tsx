import React from "react";
import { Box, Text } from "ink";
import type { CoordinatorPhase, PlanStep } from "@metalmind/core";
import type { ModelRoutingDecision } from "@metalmind/schemas";

export interface MultiAgentStatusProps {
  mainModel: string;
  mainProvider: string;
  localWorkerModel?: string;
  localWorkerProvider?: string;
  localWorkerAvailable?: boolean;
  phase: CoordinatorPhase;
  currentRouting?: ModelRoutingDecision;
  planSteps?: PlanStep[];
  taskQueue?: Array<{ taskType: string; status: string }>;
  toolCallTimeline?: Array<{ toolName: string; timestamp: string; status: string }>;
  errors?: Array<{ message: string; timestamp: string }>;
  collapsed?: boolean;
}

const PHASE_COLORS: Record<CoordinatorPhase, string> = {
  idle: "gray",
  planning: "cyan",
  "local-delegation": "green",
  "cloud-processing": "magenta",
  "tool-execution": "yellow",
  review: "blue",
  completed: "green",
  error: "red",
};

export default function MultiAgentStatus({
  mainModel,
  mainProvider,
  localWorkerModel,
  localWorkerProvider,
  localWorkerAvailable = false,
  phase,
  currentRouting,
  planSteps = [],
  taskQueue = [],
  toolCallTimeline = [],
  errors = [],
  collapsed = false,
}: MultiAgentStatusProps) {
  // Controlled by the parent (toggled with Ctrl+O); Ink has no click/mouse, so
  // the panel state lives in App, not local component state (#266).
  const expanded = !collapsed;

  const phaseColor = PHASE_COLORS[phase] ?? "white";

  if (!expanded) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold color={phaseColor}>
            [{phase}]
          </Text>
          <Text> </Text>
          <Text>
            {mainProvider}/{mainModel}
          </Text>
          {localWorkerProvider && (
            <>
              <Text dimColor> + </Text>
              <Text color={localWorkerAvailable ? "green" : "gray"}>
                {localWorkerProvider}{localWorkerModel ? `/${localWorkerModel}` : ""}
                {!localWorkerAvailable && " (offline)"}
              </Text>
            </>
          )}
          <Text> </Text>
          <Text dimColor color="gray">
            [ctrl+o to expand]
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold>Models</Text>
        </Box>
        <Text dimColor color="gray">
          [ctrl+o to collapse]
        </Text>
      </Box>

      <Box>
        <Text bold color="magenta">
          Main:{" "}
        </Text>
        <Text>
          {mainProvider}/{mainModel}
        </Text>
      </Box>

      {localWorkerProvider ? (
        <Box>
          <Text bold color="green">
            Worker:{" "}
          </Text>
          <Text color={localWorkerAvailable ? "green" : "gray"}>
            {localWorkerProvider}{localWorkerModel ? `/${localWorkerModel}` : ""}
            {!localWorkerAvailable && " (offline)"}
          </Text>
        </Box>
      ) : (
        <Box>
          <Text dimColor>Worker: none configured</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold color={phaseColor}>
          Phase: {phase}
        </Text>
      </Box>

      {currentRouting && (
        <Box>
          <Text dimColor>
            Route: {currentRouting.target} ({currentRouting.reason})
          </Text>
        </Box>
      )}

      {planSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Plan:</Text>
          {planSteps.map((step, i) => (
            <Box key={step.id ?? i}>
              <Text>
                {step.status === "completed"
                  ? "✓"
                  : step.status === "running"
                    ? "→"
                    : step.status === "failed"
                      ? "✗"
                      : step.status === "skipped"
                        ? "○"
                        : "·"}{" "}
              </Text>
              <Text
                color={
                  step.status === "completed"
                    ? "green"
                    : step.status === "running"
                      ? "yellow"
                      : step.status === "failed"
                        ? "red"
                        : "gray"
                }
              >
                {step.description}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {taskQueue.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Worker Tasks:</Text>
          {taskQueue.map((task, i) => (
            <Box key={i}>
              <Text dimColor>
                {task.status === "completed"
                  ? "✓"
                  : task.status === "running"
                    ? "→"
                    : task.status === "failed"
                      ? "✗"
                      : "·"}{" "}
                {task.taskType}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {toolCallTimeline.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Tool Calls:</Text>
          {toolCallTimeline.slice(-5).map((tc, i) => (
            <Box key={i}>
              <Text dimColor>
                {tc.status === "success" ? "✓" : tc.status === "error" ? "✗" : "→"} {tc.toolName}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {errors.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">
            Errors:
          </Text>
          {errors.slice(-3).map((err, i) => (
            <Box key={i}>
              <Text dimColor color="red">
                {err.message}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}