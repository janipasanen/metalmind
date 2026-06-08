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

  /** Model family is the name before the tag (e.g. "qwen2.5-coder:7b" → "qwen2.5-coder"). */
  private static familyOf(name: string): string {
    return name.split(":")[0];
  }

  /**
   * Resolve the requested model to an actually-installed name:
   * 1. exact tag match, else
   * 2. bare name → its ":latest" tag, else
   * 3. a same-FAMILY installed tag (exact family equality — not a prefix match,
   *    which previously let "qwen2.5-coder:1.5b" satisfy a request for ":7b").
   * Returns null when nothing of that family is installed.
   */
  private resolveInstalled(modelNames: string[]): string | null {
    if (modelNames.includes(this.modelId)) return this.modelId;
    if (!this.modelId.includes(":") && modelNames.includes(`${this.modelId}:latest`)) {
      return `${this.modelId}:latest`;
    }
    const family = OllamaWorkerProvider.familyOf(this.modelId);
    return modelNames.find((n) => OllamaWorkerProvider.familyOf(n) === family) ?? null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models: Array<{ name: string }> };
      const resolved = this.resolveInstalled(data.models.map((m) => m.name));
      // Normalize to the installed tag so sendTask never posts an unavailable id.
      if (resolved) {
        this.modelId = resolved;
        return true;
      }
      return false;
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
      const requested = this.modelId;
      const resolved = this.resolveInstalled(modelNames);

      if (!resolved) {
        return {
          available: false,
          models: modelNames,
          message: `Model "${requested}" not found. Available models: ${modelNames.join(", ") || "(none)"}. Pull it with: ollama pull ${requested}`,
        };
      }

      this.modelId = resolved; // normalize so sendTask uses a confirmed-installed id
      return {
        available: true,
        models: modelNames,
        message:
          resolved === requested
            ? `Model "${resolved}" is available`
            : `Requested "${requested}" not installed; using same-family model "${resolved}". Pull the exact tag with: ollama pull ${requested}`,
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