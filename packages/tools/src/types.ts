export interface ToolExecutionContext {
  projectRoot: string;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly requiresConfirmation: boolean;
  execute(input: TInput, executionContext: ToolExecutionContext): Promise<TOutput>;
}
