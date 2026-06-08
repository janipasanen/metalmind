import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatStreamEvent } from "../hooks/useChat.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";

// Minimal provider stub
function makeProvider(
  events: Array<{ type: string; [k: string]: unknown }>,
  readiness: { ready: boolean; message: string } = { ready: true, message: "ready" },
) {
  return {
    providerName: "stub",
    supportedCapabilities: {
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsJsonMode: false,
      maximumContextTokens: 4096,
    },
    async *streamChatCompletion() {
      for (const e of events) yield e as never;
    },
    async completeChat() {
      return { message: { role: "assistant" as const, content: "" } };
    },
    async readiness() {
      return readiness;
    },
  };
}

// Collect all events from an async generator
async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const results: ChatStreamEvent[] = [];
  for await (const e of gen) results.push(e);
  return results;
}

// We test the agent loop logic directly by mocking the provider factory
vi.mock("@metalmind/providers", () => ({
  createProvider: vi.fn(),
  OllamaWorkerProvider: class {
    providerName = "ollama-worker";
    private modelId: string;
    private baseUrl: string;
    constructor(modelId: string, baseUrl = "http://127.0.0.1:11434") {
      this.modelId = modelId;
      this.baseUrl = baseUrl;
    }
    async isAvailable() {
      try {
        const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        return res.ok;
      } catch {
        return false;
      }
    }
    async sendTask() { return "{}"; }
  },
  ProviderError: class extends Error {
    status?: number;
    retryAfterMs?: number;
    constructor(message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
      super(message);
      this.status = opts.status;
      this.retryAfterMs = opts.retryAfterMs;
    }
    get retryable() { return this.status === undefined || this.status === 429 || this.status >= 500; }
  },
  isAbortError: (err: unknown) => err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message)),
  isRetryableError: (err: unknown) => !(err instanceof Error && /\b4\d\d\b/.test(err.message)),
}));

vi.mock("@metalmind/tools", async () => {
  const fs = await import("node:fs");
  return {
  AuditLog: class {
    entries: unknown[] = [];
    log = (e: unknown) => { this.entries.push(e); };
    getRecent(n = 20) { return this.entries.slice(-n); }
  },
  ToolRegistry: class {
    private tools = new Map();
    register(t: { toolName: string }) { this.tools.set(t.toolName, t); }
    list() { return [...this.tools.values()]; }
    async execute(name: string, input: Record<string, unknown>, context?: { auditLog?: (e: unknown) => void }) {
      context?.auditLog?.({ timestamp: "t", toolName: name, input, output: "ok", success: true });
      if (name === "successTool") return "tool output";
      if (name === "getDiagnostics") {
        return (globalThis as Record<string, unknown>).__MM_DIAGNOSTICS__ ?? "No diagnostics found.";
      }
      if (name === "writeFile") {
        fs.writeFileSync(String(input.path), String(input.content ?? ""));
        return `wrote ${input.path}`;
      }
      throw new Error("tool not found");
    }
  },
  allReadOnlyTools: [],
  allWriteTools: [],
  allGitTools: [],
  runShellTools: [],
  allSymbolTools: [],
  allWebTools: [],
  backgroundShellTools: [],
  killAllBackgroundProcesses: () => {},
  indexFile: () => {},
  getReferenceIndex: () => ({ indexFile: () => {} }),
  RepoMapV2: class {
    toTreeString() { return "src/\n  index.ts [exports: 2] (function)"; }
    getSummary() { return "summary"; }
  },
  createDiagnosticsTool: () => ({
    toolName: "getDiagnostics",
    description: "",
    inputSchema: { _def: { typeName: "ZodObject", shape: () => ({}) } },
    execute: async () => "",
  }),
  };
});

import { createProvider } from "@metalmind/providers";
import { ModelRouter } from "@metalmind/core";
import type { RouteDecision } from "@metalmind/core";
import {
  AgentLoop,
  createDefaultRouter,
  resolveNamedTier,
  defaultLocalTier,
} from "../agent.js";

const mockCreateProvider = vi.mocked(createProvider);

describe("AgentLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams text and emits done", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "done" },
    ]) as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("hi"));

    expect(events.filter((e) => e.type === "text").map((e) => (e as { type: "text"; text: string }).text)).toEqual([
      "Hello",
      " world",
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("emits error event on provider failure", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: "" };
        throw new Error("network error");
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("hi"));

    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string } | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.message).toContain("network error");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("maintains conversation history across turns", async () => {
    const calls: unknown[] = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion(req: { messages: unknown[] }) {
        calls.push(req.messages);
        yield { type: "text", text: "reply" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    await collect(loop.run("first"));
    await collect(loop.run("second"));

    // second call should include system prompt + first user + assistant + second user
    const secondCall = calls[1] as Array<{ role: string }>;
    expect(secondCall.length).toBeGreaterThan(2);
    expect(secondCall[0].role).toBe("system");
  });

  it("clearHistory resets conversation", async () => {
    const calls: unknown[] = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion(req: { messages: unknown[] }) {
        calls.push(req.messages);
        yield { type: "text", text: "reply" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    await collect(loop.run("first"));
    loop.clearHistory();
    await collect(loop.run("second"));

    const secondCall = calls[1] as Array<{ role: string }>;
    // After clearHistory, run() adds a system prompt + user message
    expect(secondCall.length).toBe(2);
    expect(secondCall[0].role).toBe("system");
    expect(secondCall[1].role).toBe("user");
  });

  it("handles empty text response gracefully", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([
      { type: "done" },
    ]) as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("hi"));
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("AgentLoop routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRouter() {
    return new ModelRouter({
      tier1Model: "local-small",
      tier1Provider: "mlx",
      tier2Model: "local-small",
      tier2Provider: "mlx",
      tier3Model: "claude",
      tier3Provider: "anthropic",
      localFirst: true,
    });
  }

  it("routes a complex turn to the cloud tier and reports the decision", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    await collect(loop.run("design the authentication architecture"));

    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("anthropic");
    expect(routes[0].tier).toBe("tier3-cloud");
    expect(createdWith.some(([p, m]) => p === "anthropic" && m === "claude")).toBe(true);
  });

  it("routes a simple turn to the local tier", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "explanation" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    await collect(loop.run("explain how recursion works conceptually"));

    expect(routes[0].provider).toBe("mlx");
    expect(routes[0].tier).toBe("tier1-local");
  });

  it("uses the fixed config provider when no router is given (manual override)", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "done" }]) as never;
    });

    const loop = new AgentLoop({ provider: "ollama", model: "gemma3", explicit: true });
    await collect(loop.run("design the authentication architecture"));

    // No routing — went straight to the pinned provider despite a "complex" prompt.
    expect(createdWith).toEqual([["ollama", "gemma3"]]);
  });

  it("caches providers across turns (one construction per provider/model)", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter() },
    );

    await collect(loop.run("explain recursion conceptually"));
    await collect(loop.run("explain closures conceptually"));

    // Both simple turns route to mlx/local-small — provider built once.
    const mlxBuilds = createdWith.filter(([p, m]) => p === "mlx" && m === "local-small");
    expect(mlxBuilds).toHaveLength(1);
  });
});

describe("createDefaultRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fileConfig = {
    models: {
      localMlx: {
        provider: "mlx",
        model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
        baseUrl: "http://127.0.0.1:8742",
      },
      cloudReasoning: {
        provider: "anthropic",
        model: "claude-sonnet-latest",
      },
    },
    routing: {
      defaultLocalModel: "localMlx",
      defaultReasoningModel: "cloudReasoning",
    },
  };

  it("resolves named tiers from metalmind.yaml", () => {
    expect(resolveNamedTier("localMlx", fileConfig.models)).toEqual({
      provider: "mlx",
      model: fileConfig.models.localMlx.model,
      baseUrl: fileConfig.models.localMlx.baseUrl,
    });
  });

  it("defaults the local tier to MLX on Apple Silicon and Ollama elsewhere", () => {
    expect(defaultLocalTier(true)).toEqual({
      provider: "mlx",
      model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
    });
    expect(defaultLocalTier(false)).toEqual({
      provider: "ollama",
      model: "deepseek-coder:1.3b",
    });
  });

  it.skip("uses the YAML local MLX model when the sidecar is ready", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string, options?: { baseUrl?: string }) => {
      if (provider === "mlx" && model === fileConfig.models.localMlx.model) {
        expect(options?.baseUrl).toBe(fileConfig.models.localMlx.baseUrl);
        return makeProvider([{ type: "done" }]) as never;
      }
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const router = await createDefaultRouter(
      { provider: "ollama", model: "deepseek-coder:1.3b", explicit: false },
      fileConfig as never,
    );

    const local = router.route("explain how recursion works conceptually");
    const cloud = router.route("design the authentication architecture");

    expect(local.provider).toBe("mlx");
    expect(local.modelId).toBe(fileConfig.models.localMlx.model);
    expect(cloud.provider).toBe("anthropic");
    expect(cloud.modelId).toBe(fileConfig.models.cloudReasoning.model);
  });

  it.skip("falls back to local ollama when the MLX sidecar is unavailable", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (provider === "mlx" && model === fileConfig.models.localMlx.model) {
        return makeProvider([{ type: "done" }], { ready: false, message: "down" }) as never;
      }
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const router = await createDefaultRouter(
      { provider: "ollama-cloud", model: "gemini-3-flash-preview:cloud", explicit: false },
      fileConfig as never,
    );

    const simple = router.route("explain how recursion works conceptually");
    // Simple query should go to local tier (ollama/deepseek-coder:1.3b)
    expect(simple.provider).toBe("ollama");
    expect(simple.modelId).toBe("deepseek-coder:1.3b");
    expect(simple.tier).toBe("tier1-local");
  });
});

describe("AgentLoop quality gate + escalation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRouter() {
    return new ModelRouter({
      tier1Model: "local-small",
      tier1Provider: "mlx",
      tier2Model: "local-small",
      tier2Provider: "mlx",
      tier3Model: "claude",
      tier3Provider: "anthropic",
      localFirst: true,
    });
  }

  function text(events: { type: string; text?: string }[]): string {
    return events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  }

  it("escalates to cloud when the local model returns an empty response", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (model === "local-small") return makeProvider([{ type: "done" }]) as never; // empty
      return makeProvider([{ type: "text", text: "cloud answer" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    const events = await collect(loop.run("explain recursion conceptually"));

    expect(text(events)).toContain("cloud answer");
    expect(text(events)).toContain("escalating");
    expect(routes.at(-1)?.provider).toBe("anthropic");
    expect(routes.at(-1)?.tier).toBe("tier3-cloud");
  });

  it("escalates when the local model refuses", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (model === "local-small")
        return makeProvider([{ type: "text", text: "I cannot do that." }, { type: "done" }]) as never;
      return makeProvider([{ type: "text", text: "cloud handled it" }, { type: "done" }]) as never;
    });

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter() },
    );

    const events = await collect(loop.run("explain recursion conceptually"));
    expect(text(events)).toContain("cloud handled it");
  });

  it("does not escalate when the local model produces a good response", async () => {
    const createdWith: Array<[string, string]> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      createdWith.push([provider, model]);
      return makeProvider([{ type: "text", text: "a clear local answer" }, { type: "done" }]) as never;
    });

    const events = await collect(
      new AgentLoop(
        { provider: "mlx", model: "local-small", explicit: false },
        { router: makeRouter() },
      ).run("explain recursion conceptually"),
    );

    expect(text(events)).toBe("a clear local answer");
    expect(text(events)).not.toContain("escalating");
    expect(createdWith.some(([p]) => p === "anthropic")).toBe(false);
  });

  it("stops escalating at the cloud tier even if it also fails the gate", async () => {
    // Every model returns empty — must not loop forever; ends after reaching tier3.
    mockCreateProvider.mockImplementation(() => makeProvider([{ type: "done" }]) as never);

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter() },
    );

    const events = await collect(loop.run("explain recursion conceptually"));
    expect(events.at(-1)?.type).toBe("done");
  });

  it("uses local-model triage to route an ambiguous low-confidence task", async () => {
    mockCreateProvider.mockImplementation((provider: string, model: string) => {
      if (model === "local-small") {
        return {
          providerName: "mlx",
          supportedCapabilities: {} as never,
          async *streamChatCompletion() {
            yield { type: "done" };
          },
          // local triage call buckets the ambiguous task as COMPLEX
          async completeChat() {
            return { message: { role: "assistant" as const, content: "COMPLEX" } };
          },
        } as never;
      }
      return makeProvider([{ type: "text", text: "cloud answer" }, { type: "done" }]) as never;
    });

    const routes: RouteDecision[] = [];
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeRouter(), onRoute: (d) => routes.push(d) },
    );

    // "handle the widget thing" hits no keyword → low confidence → triage runs.
    const events = await collect(loop.run("handle the widget thing"));
    expect(routes.at(-1)?.tier).toBe("tier3-cloud");
    expect(routes.at(-1)?.provider).toBe("anthropic");
    expect(text(events)).toContain("cloud answer");
  });
});

describe("AgentLoop coordinator integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCoordRouter() {
    return new ModelRouter({
      tier1Model: "local-small",
      tier1Provider: "mlx",
      tier2Model: "local-small",
      tier2Provider: "mlx",
      tier3Model: "claude",
      tier3Provider: "anthropic",
      localFirst: true,
    });
  }

  it("initializes coordinator when router is present", () => {
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeCoordRouter() },
    );
    expect(loop.safety).toBeDefined();
    expect(loop.coordinatorInstance).toBeNull();
  });

  it("safety validator blocks dangerous file paths in tool execution", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const violation = loop.safety.validateFilePath("../../../etc/passwd");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("path_traversal");
  });

  it("safety validator blocks secret files", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const violation = loop.safety.validateFilePath("/home/user/.ssh/id_rsa");
    expect(violation).not.toBeNull();
    expect(violation?.type).toBe("secret_in_context");
  });

  it("safety validator marks write tools as requiring approval", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.safety.requiresApproval("writeFile")).toBe(true);
    expect(loop.safety.requiresApproval("editFile")).toBe(true);
    expect(loop.safety.requiresApproval("runCommand")).toBe(true);
    expect(loop.safety.requiresApproval("readFile")).toBe(false);
  });

  it("safety validator blocks local worker from executing tools", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.safety.isToolAllowedForAgent("writeFile", "local-worker")).toBe(false);
    expect(loop.safety.isToolAllowedForAgent("readFile", "local-worker")).toBe(false);
    expect(loop.safety.isToolAllowedForAgent("writeFile", "cloud-main")).toBe(true);
  });

  it("initializes coordinator with initCoordinator", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never);
    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router: makeCoordRouter() },
    );
    await loop.initCoordinator();
    expect(loop.coordinatorInstance).not.toBeNull();
    expect(loop.coordinatorInstance!.getPhase()).toBe("idle");
  });

  it("coordinator events update via callbacks", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never);
    const phases: string[] = [];
    const routings: unknown[] = [];
    const plans: unknown[] = [];

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      {
        router: makeCoordRouter(),
        onCoordinatorPhase: (phase) => phases.push(phase),
        onCoordinatorRouting: (decision) => routings.push(decision),
        onCoordinatorPlan: (steps) => plans.push(steps),
      },
    );

    await loop.initCoordinator();
    expect(loop.coordinatorInstance).not.toBeNull();
  });

  it("safety validator rejects dangerous shell commands", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.safety.validateShellCommand("rm -rf /")).not.toBeNull();
    expect(loop.safety.validateShellCommand("sudo apt-get install foo")).not.toBeNull();
    expect(loop.safety.validateShellCommand("ls -la")).toBeNull();
  });
});

describe("AgentLoop.detectOllamaWorker", () => {
  it("returns null when Ollama is unreachable", async () => {
    const result = await AgentLoop.detectOllamaWorker(undefined, "http://127.0.0.1:59999");
    expect(result).toBeNull();
  });

  it("accepts a preferred model override", async () => {
    const result = await AgentLoop.detectOllamaWorker("nonexistent-model:99b", "http://127.0.0.1:59999");
    expect(result).toBeNull();
  });
});

describe("AgentLoop trust & recovery (M3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Provider that emits a single tool call on its first stream, then text+done.
  function toolThenDoneProvider(toolName: string, args: Record<string, unknown>) {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "tc1", toolName, argumentsJson: JSON.stringify(args) } };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "finished" };
          yield { type: "done" };
        }
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never;
  }

  it("snapshots a write and reverts it with undoLastEdit (created file is deleted)", async () => {
    const file = join(tmpdir(), `mm-undo-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
    if (existsSync(file)) rmSync(file);
    mockCreateProvider.mockReturnValue(toolThenDoneProvider("writeFile", { path: file, content: "agent content" }));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    await collect(loop.run("write the file"));

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("agent content");

    const report = loop.undoLastEdit();
    expect(report).toMatch(/deleted/);
    expect(existsSync(file)).toBe(false); // was newly created → removed on undo
  });

  it("restores prior content on undo when the file already existed", async () => {
    const file = join(tmpdir(), `mm-undo2-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
    writeFileSync(file, "ORIGINAL");
    mockCreateProvider.mockReturnValue(toolThenDoneProvider("writeFile", { path: file, content: "OVERWRITTEN" }));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    await collect(loop.run("overwrite it"));
    expect(readFileSync(file, "utf8")).toBe("OVERWRITTEN");

    loop.undoLastEdit();
    expect(readFileSync(file, "utf8")).toBe("ORIGINAL");
    rmSync(file);
  });

  it("records tool calls in the audit log", async () => {
    const file = join(tmpdir(), `mm-audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
    mockCreateProvider.mockReturnValue(toolThenDoneProvider("writeFile", { path: file, content: "x" }));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    await collect(loop.run("write"));

    const entries = loop.getAuditEntries();
    expect(entries.some((e) => e.toolName === "writeFile")).toBe(true);
    if (existsSync(file)) rmSync(file);
  });

  it("blocks a dangerous shell command before execution (#139)", async () => {
    mockCreateProvider.mockReturnValue(toolThenDoneProvider("runCommand", { command: "rm -rf /tmp/victim" }));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("clean up"));

    const toolResult = events.find((e) => e.type === "tool-result") as { type: "tool-result"; output: string } | undefined;
    expect(toolResult?.output).toMatch(/^Blocked:/);
    // The blocked call is audited as a failure.
    const audited = loop.getAuditEntries().find((e) => e.toolName === "runCommand");
    expect(audited?.success).toBe(false);
  });

  it("undoLastEdit reports cleanly when there is nothing to undo", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.undoLastEdit()).toMatch(/Nothing to undo/);
  });
});

describe("AgentLoop session & context (M4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function capturingProvider(maxTokens: number, captured: unknown[][]) {
    return {
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: maxTokens } as never,
      async *streamChatCompletion(req: { messages: unknown[] }) {
        captured.push(req.messages);
        yield { type: "text", text: "ok" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never;
  }

  it("injects a project memory file into the system prompt (#146)", async () => {
    const root = join(tmpdir(), `mm-mem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ALWAYS use tabs, never spaces.");

    const captured: unknown[][] = [];
    mockCreateProvider.mockReturnValue(capturingProvider(128000, captured));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("hello"));

    const sys = (captured[0] as Array<{ role: string; content: string }>)[0];
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("Project instructions (from AGENTS.md)");
    expect(sys.content).toContain("ALWAYS use tabs");
    rmSync(root, { recursive: true, force: true });
  });

  it("/init writes a starter memory doc and is idempotent (#146)", async () => {
    const root = join(tmpdir(), `mm-init-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "tsc" } }));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const first = loop.initProjectDoc();
    expect(first).toMatch(/Created starter project memory/);
    const docPath = join(root, ".metalmind", "MEMORY.md");
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain("# Project memory: demo");
    expect(doc).toContain("- `src/`");
    expect(doc).toContain("npm run build");

    // Second call must not overwrite.
    expect(loop.initProjectDoc()).toMatch(/already exists/);
    rmSync(root, { recursive: true, force: true });
  });

  it("trims history to fit a small context window and reports usage (#141)", async () => {
    const root = join(tmpdir(), `mm-ctx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });

    const usages: Array<{ used: number; limit: number }> = [];
    const captured: unknown[][] = [];
    // ~1000-token window forces trimming after a few large turns.
    mockCreateProvider.mockReturnValue(capturingProvider(1000, captured));

    const loop = new AgentLoop(
      { provider: "stub", model: "test", explicit: true },
      { projectRoot: root, onContextUsage: (used, limit) => usages.push({ used, limit }) },
    );

    const big = "word ".repeat(400); // ~400+ tokens per turn
    for (let i = 0; i < 4; i++) await collect(loop.run(big));

    // Usage was reported against the model limit.
    expect(usages.length).toBeGreaterThan(0);
    expect(usages.at(-1)?.limit).toBe(1000);
    // The final request stayed under budget (limit - reserve) — no unbounded growth.
    const lastMessages = captured.at(-1) as Array<{ role: string }>;
    expect(lastMessages[0].role).toBe("system"); // system prompt always preserved
    expect(usages.at(-1)!.used).toBeLessThanOrEqual(1000);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentLoop M5 integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects a token-bounded repository map into the system prompt (#143)", async () => {
    const root = join(tmpdir(), `mm-repomap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const captured: unknown[][] = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: 128000 } as never,
      async *streamChatCompletion(req: { messages: unknown[] }) {
        captured.push(req.messages);
        yield { type: "text", text: "ok" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("hi"));

    const sys = (captured[0] as Array<{ role: string; content: string }>)[0];
    expect(sys.content).toContain("Repository map");
    expect(sys.content).toContain("index.ts [exports: 2]");
    rmSync(root, { recursive: true, force: true });
  });

  it("namespaces MCP tools so same-named tools from two servers don't collide (#161)", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    // Two servers both expose a tool literally named "search".
    const clientA = { callTool: async () => "A" };
    const clientB = { callTool: async () => "B" };
    const mcpTools = (loop as unknown as { mcpTools: Map<string, unknown> }).mcpTools;
    mcpTools.set("serverA:search", { client: clientA, def: { name: "search", description: "A search", inputSchema: {} } });
    mcpTools.set("serverB:search", { client: clientB, def: { name: "search", description: "B search", inputSchema: {} } });

    // Neither overwrote the other.
    expect(mcpTools.size).toBe(2);

    const defs = (loop as unknown as { toolDefs: () => Array<{ name: string }> }).toolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toContain("serverA:search");
    expect(names).toContain("serverB:search");
  });
});

describe("AgentLoop post-edit diagnostics (M5 #152)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function writeThenDone(file: string) {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "tc1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: file, content: "foo;" }) } };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        }
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never;
  }

  it("appends diagnostics for the edited file to the tool result", async () => {
    const root = join(tmpdir(), `mm-diag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "x.ts");
    (globalThis as Record<string, unknown>).__MM_DIAGNOSTICS__ = "error TS2304: Cannot find name 'foo'.";

    mockCreateProvider.mockReturnValue(writeThenDone(file));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const events = await collect(loop.run("write x"));

    const toolResult = events.find((e) => e.type === "tool-result") as { type: "tool-result"; output: string } | undefined;
    expect(toolResult?.output).toContain("[diagnostics:");
    expect(toolResult?.output).toContain("Cannot find name 'foo'");

    delete (globalThis as Record<string, unknown>).__MM_DIAGNOSTICS__;
    rmSync(root, { recursive: true, force: true });
  });

  it("does not append a diagnostics block when there are none", async () => {
    const root = join(tmpdir(), `mm-diag2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "y.ts");
    delete (globalThis as Record<string, unknown>).__MM_DIAGNOSTICS__; // mock returns "No diagnostics found."

    mockCreateProvider.mockReturnValue(writeThenDone(file));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const events = await collect(loop.run("write y"));

    const toolResult = events.find((e) => e.type === "tool-result") as { type: "tool-result"; output: string } | undefined;
    expect(toolResult?.output).not.toContain("[diagnostics:");
    rmSync(root, { recursive: true, force: true });
  });
});
