import type { WorkerProvider } from "@metalmind/core";
import type { LocalWorkerTask } from "@metalmind/schemas";

export class OllamaWorkerProvider implements WorkerProvider {
  readonly providerName = "ollama-worker";
  private baseUrl: string;
  private modelId: string;
  private apiKey?: string;

  constructor(modelId: string, baseUrl = "http://127.0.0.1:11434", apiKey?: string) {
    this.modelId = modelId;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models: Array<{ name: string }> };
      return data.models.some((m) => m.name === this.modelId || m.name.startsWith(this.modelId.split(":")[0]));
    } catch {
      return false;
    }
  }

  async checkModelAvailability(): Promise<{ available: boolean; models: string[]; message: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return {
          available: false,
          models: [],
          message: `Ollama not reachable at ${this.baseUrl}. Start it with: ollama serve`,
        };
      }
      const data = (await res.json()) as { models: Array<{ name: string }> };
      const modelNames = data.models.map((m) => m.name);
      const exactMatch = modelNames.includes(this.modelId);
      const prefixMatch = modelNames.some((n) => n.startsWith(this.modelId.split(":")[0]));

      if (!exactMatch && !prefixMatch) {
        return {
          available: false,
          models: modelNames,
          message: `Model "${this.modelId}" not found. Available models: ${modelNames.join(", ") || "(none)"}. Pull it with: ollama pull ${this.modelId}`,
        };
      }

      return {
        available: true,
        models: modelNames,
        message: `Model "${this.modelId}" is available`,
      };
    } catch {
      return {
        available: false,
        models: [],
        message: `Ollama not reachable at ${this.baseUrl}. Install Ollama from https://ollama.ai and start it with: ollama serve`,
      };
    }
  }

  async sendTask(task: LocalWorkerTask): Promise<string> {
    const schemas = (await import("@metalmind/schemas")).LOCAL_WORKER_TASK_SCHEMAS;
    const taskSchema = schemas[task.taskType];
    if (!taskSchema) {
      throw new Error(`Unknown task type: ${task.taskType}`);
    }

    const jsonSchema = taskSchema.output;
    const shape = jsonSchema._def?.shape ?? {};
    const properties: Record<string, string> = {};
    for (const key of Object.keys(shape)) {
      properties[key] = typeof shape[key] === "object" && shape[key]?._def?.typeName === "ZodNumber" ? "number" : "string";
    }

    const prompt = this.buildPrompt(task);

    const body = {
      model: this.modelId,
      messages: [
        {
          role: "system",
          content: `You are a helpful coding assistant. Respond ONLY with valid JSON matching this schema. Do not include any text before or after the JSON object.\n\nSchema properties: ${JSON.stringify(properties)}`,
        },
        { role: "user", content: prompt },
      ],
      stream: false,
      format: "json",
      options: {
        num_predict: task.maximumOutputTokens ?? 800,
        temperature: 0.3,
      },
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Ollama worker request failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { message: { content: string } };
    return data.message.content;
  }

  private buildPrompt(task: LocalWorkerTask): string {
    const inputStr = JSON.stringify(task.input, null, 2);

    const taskPrompts: Record<string, string> = {
      classifyUserIntent: "Classify the user's intent from the following message. Valid intents: question, code_change, debug, explain, search, refactor, test, deploy, greeting, other. Respond with a JSON object with keys: intent, confidence, suggestedTier, reason.",
      rankRelevantFiles: "Rank the following files by relevance to the described goal. Respond with a JSON object.",
      summarizeFile: "Summarize the following file content. Respond with a JSON object.",
      summarizeDiff: "Summarize the following diff. Respond with a JSON object.",
      summarizeCommandOutput: "Summarize the following command output. Respond with a JSON object.",
      extractSymbols: "Extract all symbols (functions, classes, interfaces, etc.) from the following code. Respond with a JSON object.",
      extractImports: "Extract all imports from the following code. Respond with a JSON object.",
      identifyLikelyTestFiles: "Identify which files are likely test files for the given source file. Respond with a JSON object.",
      generateCommitMessageDraft: "Generate a concise commit message for the following changes. Respond with a JSON object.",
      validateJsonLikeOutput: "Determine if the following text is valid JSON and matches the expected schema type. Respond with a JSON object.",
      suggestSimpleEdit: "Suggest a simple edit for the following file based on the instruction. Respond with a JSON object.",
      explainCompilerError: "Explain the following compiler error. Respond with a JSON object.",
    };

    const taskDescription = taskPrompts[task.taskType] ?? `Perform the following task: ${task.taskType}. Respond with a JSON object.`;

    return `${taskDescription}\n\nInput:\n${inputStr}`;
  }
}