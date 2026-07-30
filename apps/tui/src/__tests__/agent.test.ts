import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
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
      if (name === "readFile") {
        return `read:${input.path}`;
      }
      // Deterministic stand-ins for the /commit, /pr, and /test flows (M28).
      if (name === "runTests") return "42 tests passed\n--- Tests passed, 5ms";
      if (name === "runLint") return "clean\n--- Lint passed, 5ms";
      if (name === "runCommand") return "ok\n--- Exit: 0, 5ms";
      if (name === "gitStatus") return " M a.ts";
      if (name === "gitAdd") return "";
      if (name === "gitDiff") return "diff --git a/a.ts b/a.ts\n+new line";
      if (name === "gitCommit") return "[main abc123] committed";
      if (name === "gitCurrentBranch") return "feature/x";
      if (name === "gitPush") return "branch pushed";
      if (name === "gitLog") return "abc123 feat: earlier work";
      if (name === "createPullRequest") return "https://github.com/x/y/pull/7";
      throw new Error("tool not found");
    }
  },
  allReadOnlyTools: [],
  allWriteTools: [],
  allGitTools: [],
  runShellTools: [],
  allSymbolTools: [],
  allWebTools: [],
  allDocumentTools: [],
  backgroundShellTools: [],
  isBlockedPath: (p: string) => /(^|\/|\\)(\.ssh|\.gnupg|\.aws|\.kube|\.env|\.git-credentials|\.npmrc|id_rsa|id_ed25519|authorized_keys)(\/|\\|$)/.test(p),
  // Async shell runner used by project check, format-on-write, and lifecycle
  // hooks — a successful no-op keeps those paths inert in unit tests.
  runShellAsync: async () => ({ stdout: "", stderr: "", exitCode: 0, duration: 1 }),
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
import { XDG_CONFIG_FILE } from "@metalmind/config";
import {
  AgentLoop,
  createDefaultRouter,
  resolveNamedTier,
  defaultLocalTier,
} from "../agent.js";

const mockCreateProvider = vi.mocked(createProvider);

// Isolate these tests from the developer's personal config — persisted tier
// overrides / remote-brain would otherwise change routing outcomes (#235).
let __cfgBackup: string | null = null;
function stripVolatileConfig(): void {
  try {
    const raw = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : "{}";
    const c = JSON.parse(raw);
    delete c.tierModels;
    delete c.remoteBrain;
    delete c.budgetUsd;
    writeFileSync(XDG_CONFIG_FILE, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}
beforeAll(() => {
  __cfgBackup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null;
  stripVolatileConfig();
});
// Re-strip right before every test: another parallel test file can write the
// shared config mid-run, and the agent reads it at construction (#235 flake).
beforeEach(() => stripVolatileConfig());
afterAll(() => {
  if (__cfgBackup !== null) writeFileSync(XDG_CONFIG_FILE, __cfgBackup);
});

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

  it("terminates escalation when an exceeded budget keeps downgrading the cloud tier (#249)", async () => {
    // Over budget (budgetUsd: 0): the router rewrites any tier3-cloud target back
    // to tier1-local. Every model returns empty (fails the gate), so without the
    // escalation guard the loop would cycle forever. It must still finish.
    mockCreateProvider.mockImplementation(() => makeProvider([{ type: "done" }]) as never);
    const router = new ModelRouter({
      tier1Model: "local-small", tier1Provider: "mlx",
      tier2Model: "local-small", tier2Provider: "mlx",
      tier3Model: "claude", tier3Provider: "anthropic",
      localFirst: true, budgetUsd: 0,
    });

    const loop = new AgentLoop(
      { provider: "mlx", model: "local-small", explicit: false },
      { router },
    );

    const events = await collect(loop.run("explain recursion conceptually"));
    expect(events.at(-1)?.type).toBe("done"); // did not hang
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

describe("AgentLoop skills (M5 #156)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSkillDir(): string {
    const root = join(tmpdir(), `mm-skill-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, ".metalmind", "skills", "bananas"), { recursive: true });
    writeFileSync(
      join(root, ".metalmind", "skills", "bananas", "SKILL.md"),
      ["---", "name: bananas", "version: 1.0.0", "description: Always mention bananas", "---", "", "When this skill is active, always mention BANANA in your answer."].join("\n"),
    );
    return root;
  }

  it("discovers, activates, and injects a skill prompt into the system prompt", async () => {
    const root = makeSkillDir();
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

    expect(loop.listSkills()).toContain("bananas");
    expect(loop.activateSkill("bananas")).toMatch(/Activated skill "bananas"/);

    await collect(loop.run("hi"));
    const sys = (captured[0] as Array<{ role: string; content: string }>)[0];
    expect(sys.content).toContain("Active skills");
    expect(sys.content).toContain("always mention BANANA");

    // Deactivation removes it.
    expect(loop.deactivateSkill("bananas")).toMatch(/Deactivated/);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a helpful message for an unknown skill", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: tmpdir() });
    expect(loop.activateSkill("nope-not-real")).toMatch(/not found/);
  });
});

describe("AgentLoop persistence (M4 #140)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function replyProvider(text: string) {
    return makeProvider([{ type: "text", text }, { type: "done" }]) as never;
  }

  it("persists history and resumes it in a new agent via --continue", async () => {
    const root = join(tmpdir(), `mm-persist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });

    mockCreateProvider.mockReturnValue(replyProvider("the assistant reply"));
    const loop1 = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await loop1.initPersistence({});
    await collect(loop1.run("hello world"));

    // A brand-new agent over the same project resumes the most recent session.
    const loop2 = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const restored = await loop2.initPersistence({ continue: true });

    expect(restored.some((m) => m.role === "user" && m.content === "hello world")).toBe(true);
    expect(restored.some((m) => m.role === "assistant" && m.content.includes("the assistant reply"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("lists sessions and resumes a specific one by id", async () => {
    const root = join(tmpdir(), `mm-persist2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });

    mockCreateProvider.mockReturnValue(replyProvider("reply one"));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await loop.initPersistence({});
    await collect(loop.run("first message"));

    const sessions = loop.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // newSession starts a fresh one without destroying the old.
    loop.newSession();
    expect(loop.listSessions().length).toBe(sessions.length + 1);

    // Resume the original by id.
    const restored = loop.resumeSession(sessions[0].id);
    expect(restored.some((m) => m.content === "first message")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("degrades gracefully when persistence is unused (no session store)", async () => {
    mockCreateProvider.mockReturnValue(replyProvider("ok"));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    // No initPersistence call — run must still work and listSessions returns empty.
    const events = await collect(loop.run("hi"));
    expect(events.at(-1)?.type).toBe("done");
    expect(loop.listSessions()).toEqual([]);
  });
});

describe("AgentLoop approval gate (M3 #138)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function oneWrite(file: string, content: string) {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "tc1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: file, content }) } };
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

  it("rejecting an approval blocks the write and returns a rejection result", async () => {
    const root = join(tmpdir(), `mm-appr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "x.ts");
    mockCreateProvider.mockReturnValue(oneWrite(file, "should not be written"));

    const loop = new AgentLoop(
      { provider: "stub", model: "test", explicit: true },
      { projectRoot: root, onApprovalRequest: async () => "reject" },
    );
    const events = await collect(loop.run("write x"));

    expect(existsSync(file)).toBe(false); // no mutation on reject
    const toolResult = events.find((e) => e.type === "tool-result") as { type: "tool-result"; output: string } | undefined;
    expect(toolResult?.output).toMatch(/Rejected by user/);
    rmSync(root, { recursive: true, force: true });
  });

  it("approving lets the write through", async () => {
    const root = join(tmpdir(), `mm-appr2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "y.ts");
    mockCreateProvider.mockReturnValue(oneWrite(file, "approved content"));

    const loop = new AgentLoop(
      { provider: "stub", model: "test", explicit: true },
      { projectRoot: root, onApprovalRequest: async () => "approve" },
    );
    await collect(loop.run("write y"));

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("approved content");
    rmSync(root, { recursive: true, force: true });
  });

  it("always-allow is scoped to the approved path; a new path re-prompts (#241)", async () => {
    const root = join(tmpdir(), `mm-appr3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const f1 = join(root, "a.ts");
    const f2 = join(root, "b.ts");
    let calls = 0;
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          // Two writes to the SAME path, then one to a DIFFERENT path.
          yield { type: "tool-call", toolCall: { toolCallId: "t1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: f1, content: "a" }) } };
          yield { type: "tool-call", toolCall: { toolCallId: "t2", toolName: "writeFile", argumentsJson: JSON.stringify({ path: f1, content: "aa" }) } };
          yield { type: "tool-call", toolCall: { toolCallId: "t3", toolName: "writeFile", argumentsJson: JSON.stringify({ path: f2, content: "b" }) } };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        }
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const approvalSpy = vi.fn(async () => "always" as const);
    const loop = new AgentLoop(
      { provider: "stub", model: "test", explicit: true },
      { projectRoot: root, onApprovalRequest: approvalSpy },
    );
    await collect(loop.run("write some"));

    // Prompted once for f1 (second write to f1 auto-approved by the scoped grant),
    // and once more for f2 — a different target is not covered by f1's grant.
    expect(approvalSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(f1)).toBe(true);
    expect(existsSync(f2)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not gate when no approval callback is wired (headless)", async () => {
    const root = join(tmpdir(), `mm-appr4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "z.ts");
    mockCreateProvider.mockReturnValue(oneWrite(file, "headless"));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("write z"));
    expect(existsSync(file)).toBe(true); // no callback → executes
    rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentLoop /compact and /export (M4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("compacts older turns into a summary, keeping recent ones (#145)", async () => {
    let calls = 0;
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        yield { type: "text", text: `reply ${calls}` };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "SUMMARY of earlier chat" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: tmpdir() });
    for (let i = 0; i < 5; i++) await collect(loop.run(`message ${i}`));

    const msg = await loop.compactHistory();
    expect(msg).toMatch(/Compacted \d+ earlier messages/);
    // The export should now contain the summary marker and the recent turns.
    const file = loop.exportTranscript("md");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("Summary of");
    rmSync(file, { force: true });
  });

  it("exports the transcript to markdown and json (#154)", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "hello there" }, { type: "done" }]) as never);
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: tmpdir() });
    await collect(loop.run("a question"));

    const md = loop.exportTranscript("md");
    expect(md).toMatch(/\.md$/);
    const mdContent = readFileSync(md, "utf-8");
    expect(mdContent).toContain("## You");
    expect(mdContent).toContain("a question");
    expect(mdContent).toContain("hello there");

    const jsonPath = loop.exportTranscript("json");
    expect(jsonPath).toMatch(/\.json$/);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(Array.isArray(parsed)).toBe(true);

    rmSync(md, { force: true });
    rmSync(jsonPath, { force: true });
  });

  it("/compact reports nothing to do on a short history", async () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: tmpdir() });
    expect(await loop.compactHistory()).toMatch(/nothing to compact/i);
  });
});

describe("AgentLoop token usage (M6 #157)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accumulates provider usage events and reports via getSessionUsage + onUsage", async () => {
    const usageCb = vi.fn();
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: "hi" };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 25 } };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop(
      { provider: "stub", model: "test", explicit: true },
      { projectRoot: tmpdir(), onUsage: usageCb },
    );
    await collect(loop.run("a"));
    await collect(loop.run("b")); // second turn accumulates

    expect(loop.getSessionUsage()).toEqual({ inputTokens: 200, outputTokens: 50 });
    expect(usageCb).toHaveBeenLastCalledWith({ inputTokens: 200, outputTokens: 50 });
  });
});

describe("AgentLoop undo/redo, routes, health (M6 #176, #165, #174)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function writeTurn(file: string, content: string) {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "t1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: file, content }) } };
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

  it("undo then redo round-trips an edit (#176)", async () => {
    const root = join(tmpdir(), `mm-redo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const file = join(root, "f.ts");
    writeFileSync(file, "ORIGINAL");

    mockCreateProvider.mockReturnValue(writeTurn(file, "EDITED"));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("edit it"));
    expect(readFileSync(file, "utf-8")).toBe("EDITED");

    expect(loop.undoLastEdit()).toMatch(/Undid an edit set/);
    expect(readFileSync(file, "utf-8")).toBe("ORIGINAL");

    expect(loop.redoLastEdit()).toMatch(/Redid an edit set/);
    expect(readFileSync(file, "utf-8")).toBe("EDITED");

    expect(loop.redoLastEdit()).toMatch(/Nothing to redo/);
    rmSync(root, { recursive: true, force: true });
  });

  it("records routing decisions for /routes via the forced-tier path (#165)", async () => {
    const router = await createDefaultRouter({ provider: "ollama", model: "x", explicit: false } as never);
    const loop = new AgentLoop({ provider: "ollama", model: "x", explicit: false }, { projectRoot: tmpdir(), router });
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never);
    loop.setForcedTier(3); // deterministic route, no network classification
    await collect(loop.run("hello"));
    expect(loop.getRoutingSummary()).toMatch(/Routing hit counts/);
  });

  it("checkHealth returns ok:true when the provider has no health hook", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "done" }]) as never);
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: tmpdir() });
    const h = await loop.checkHealth();
    expect(h.ok).toBe(true);
  });
});

describe("M7 — model orchestration: persisted local/cloud selection + remote brain (#185/#186)", () => {
  // Snapshot/restore the real XDG config so these persistence tests are non-destructive.
  let backup: string | null = null;
  beforeEach(() => {
    backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null;
  });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("setTierModel persists and is restored into tier overrides on the next launch (#185)", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    loop.setTierModel(2, "ollama", "ministral-3:3b");
    expect(loop.getTierModel(2)).toEqual({ provider: "ollama", model: "ministral-3:3b" });
    loop.setTierModel(3, "ollama-cloud", "gemini-3-flash-preview:latest");

    // A freshly constructed loop restores both persisted per-tier overrides.
    const next = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(next.getTierModel(2)).toEqual({ provider: "ollama", model: "ministral-3:3b" });
    expect(next.getTierModel(3)).toEqual({ provider: "ollama-cloud", model: "gemini-3-flash-preview:latest" });
  });

  it("remote-brain mode persists across launches (#186)", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.isRemoteBrain()).toBe(false);
    loop.setRemoteBrain(true);
    expect(loop.isRemoteBrain()).toBe(true);

    const next = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(next.isRemoteBrain()).toBe(true);

    next.setRemoteBrain(false);
    expect(new AgentLoop({ provider: "stub", model: "test", explicit: true }).isRemoteBrain()).toBe(false);
  });
});

describe("M12 — parallel read-only tool execution (#206)", () => {
  // Provider that emits two read-only tool calls on the first stream, then text+done.
  function twoReadsThenDone() {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "r1", toolName: "readFile", argumentsJson: JSON.stringify({ path: "a.ts" }) } };
          yield { type: "tool-call", toolCall: { toolCallId: "r2", toolName: "readFile", argumentsJson: JSON.stringify({ path: "b.ts" }) } };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done reading" };
          yield { type: "done" };
        }
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never;
  }

  it("runs a batch of read-only calls and returns all results in order", async () => {
    mockCreateProvider.mockReturnValue(twoReadsThenDone());
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("read both files"));
    const outputs = events
      .filter((e) => e.type === "tool-result")
      .map((e) => (e as { type: "tool-result"; output: string }).output);
    expect(outputs).toEqual(["read:a.ts", "read:b.ts"]);
  });
});

describe("M12 — per-tier latency tracking (#209)", () => {
  it("feeds latency from usage events and surfaces it in /routes", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: "hi" };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: "done" };
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    const router = new ModelRouter();
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { router });
    loop.setForcedTier(1); // forces a recorded route so lastTier is set
    await collect(loop.run("hello"));

    const stats = loop.getLatencyStats();
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].samples).toBeGreaterThanOrEqual(1);
    expect(stats[0].tier).toBe("tier1-local");
    expect(loop.getRoutingSummary()).toContain("Latency per tier");
  });
});

describe("M12 — general sub-agent / task delegation (#210)", () => {
  // calls: 1=parent delegates, 2=sub-agent answers, 3=parent finalizes.
  function taskFlowProvider() {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "tk1", toolName: "task", argumentsJson: JSON.stringify({ objective: "find the answer" }) } };
          yield { type: "done" };
        } else if (calls === 2) {
          yield { type: "text", text: "the answer is 42" };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done: 42" };
          yield { type: "done" };
        }
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never;
  }

  it("runs a sub-agent and returns its result without leaking its text to the parent stream", async () => {
    mockCreateProvider.mockReturnValue(taskFlowProvider());
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    const events = await collect(loop.run("delegate it"));

    const toolResult = events.find((e) => e.type === "tool-result") as { type: "tool-result"; output: string } | undefined;
    expect(toolResult?.output).toContain("Sub-agent result:");
    expect(toolResult?.output).toContain("the answer is 42");

    // The sub-agent's internal text must NOT appear as parent-visible text events.
    const parentText = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { type: "text"; text: string }).text)
      .join("");
    expect(parentText).toContain("done: 42");
    expect(parentText).not.toContain("the answer is 42");
  });
});

describe("M12 — coordinator-path streaming (#211)", () => {
  let backup: string | null = null;
  beforeEach(() => {
    backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null;
  });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  function makeCoordRouter() {
    return new ModelRouter({
      tier1Model: "local-small", tier1Provider: "mlx",
      tier2Model: "local-small", tier2Provider: "mlx",
      tier3Model: "claude", tier3Provider: "anthropic",
      localFirst: true,
    });
  }
  const worker = {
    providerName: "w",
    async isAvailable() { return true; },
    async sendTask() { return JSON.stringify({ suggestedTier: "cloud-main" }); },
  };

  it("streams tier-3 token-by-token instead of buffering, in remote-brain mode", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: "Hel" };
        yield { type: "text", text: "lo" };
        yield { type: "done" };
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    const loop = new AgentLoop({ provider: "anthropic", model: "claude", apiKey: "test-key", explicit: false }, { router: makeCoordRouter() });
    await loop.initCoordinator(worker as never);
    loop.setRemoteBrain(true);

    const events = await collect(loop.run("hi there")); // short input → no plan path
    const textEvents = events.filter((e) => e.type === "text") as Array<{ type: "text"; text: string }>;
    expect(textEvents.length).toBeGreaterThanOrEqual(2); // streamed in chunks, not one blob
    expect(textEvents.map((e) => e.text).join("")).toContain("Hello");
  });
});

describe("M12 — latency is attributed per-attempt tier, not a stale one (#209 review fix)", () => {
  it("records distinct tiers across forced-tier turns", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: "x" };
        yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } };
        yield { type: "done" };
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { router: new ModelRouter() });
    loop.setForcedTier(1);
    await collect(loop.run("first"));
    loop.setForcedTier(3);
    await collect(loop.run("second"));

    const tiers = loop.getLatencyStats().map((s) => s.tier).sort();
    expect(tiers).toContain("tier1-local");
    expect(tiers).toContain("tier3-cloud");
    // Each tier got exactly its own turn's sample — not both lumped onto one tier.
    for (const s of loop.getLatencyStats()) expect(s.samples).toBe(1);
  });
});

describe("M14 — image staging (#177)", () => {
  it("stages an image and clears it after attaching to the next turn", async () => {
    mockCreateProvider.mockReturnValue(makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never);
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    loop.stageImage("data:image/png;base64,AAAA");
    expect(loop.pendingImageCount()).toBe(1);
    await collect(loop.run("describe the image"));
    expect(loop.pendingImageCount()).toBe(0); // attached to the turn + cleared
  });
});

describe("M15 — long-term memory (#218)", () => {
  it("rememberFact appends to .metalmind/MEMORY.md and it loads into the next session's prompt", async () => {
    const root = join(tmpdir(), `mm-mem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    // A project doc exists, so learned memory must load as a *separate* section.
    writeFileSync(join(root, "AGENTS.md"), "# Project\nStanding instructions.");
    try {
      const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
      const res = loop.rememberFact("the build command is npm run build");
      expect(res).toContain("Remembered");
      const memPath = join(root, ".metalmind", "MEMORY.md");
      expect(existsSync(memPath)).toBe(true);
      expect(readFileSync(memPath, "utf8")).toContain("the build command is npm run build");

      // A freshly constructed agent injects it into the system message of its first turn.
      let systemMsg = "";
      mockCreateProvider.mockReturnValue({
        providerName: "stub",
        supportedCapabilities: {} as never,
        async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
          systemMsg = req.messages.find((m) => m.role === "system")?.content ?? "";
          yield { type: "text", text: "ok" };
          yield { type: "done" };
        },
        async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
      } as never);
      const next = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
      await collect(next.run("hi"));
      expect(systemMsg).toContain("Long-term memory");
      expect(systemMsg).toContain("the build command is npm run build");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M15 — persistent approval allowlist skips the prompt (#220)", () => {
  let backup: string | null = null;
  beforeEach(() => { backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null; });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("an allowlisted writeFile executes without requesting approval", async () => {
    // Pre-approve writeFile in the persisted config.
    const cfg = JSON.parse(readFileSync(XDG_CONFIG_FILE, "utf-8"));
    writeFileSync(XDG_CONFIG_FILE, JSON.stringify({ ...cfg, approvalAllowlist: { tools: ["writeFile"] } }));

    let calls = 0;
    mockCreateProvider.mockReturnValue((() => {
      let n = 0;
      const file = join(tmpdir(), `mm-allow-${Date.now()}.txt`);
      return {
        providerName: "stub",
        supportedCapabilities: {} as never,
        async *streamChatCompletion() {
          n++;
          if (n === 1) {
            yield { type: "tool-call", toolCall: { toolCallId: "w1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: file, content: "x" }) } };
            yield { type: "done" };
          } else {
            yield { type: "text", text: "done" };
            yield { type: "done" };
          }
        },
        async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
      };
    })() as never);

    const onApprovalRequest = async () => { calls++; return "approve" as const; };
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { onApprovalRequest });
    await collect(loop.run("write a file"));
    expect(calls).toBe(0); // allowlisted → no approval prompt
  });
});

describe("M13 — message retry / edit (#204)", () => {
  it("popLastExchange drops the last user turn and returns its text for re-run", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() { yield { type: "text", text: "answer" }; yield { type: "done" }; },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    await collect(loop.run("first question"));
    expect(loop.conversation().some((m) => m.role === "assistant" && m.content === "answer")).toBe(true);

    const popped = loop.popLastExchange();
    expect(popped).toBe("first question");
    // The assistant answer and the user turn are gone.
    expect(loop.conversation().some((m) => m.content === "answer")).toBe(false);
    expect(loop.conversation().some((m) => m.content === "first question")).toBe(false);
  });

  it("popLastExchange returns null when there is nothing to retry", () => {
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    expect(loop.popLastExchange()).toBeNull();
  });
});

describe("M16 — streamed text is redacted (#223)", () => {
  it("redacts a secret the model echoes in its streamed response", async () => {
    const secret = "sk-supersecret-key-1234567890";
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: `the api key is ${secret} ok` };
        yield { type: "done" };
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", apiKey: secret, explicit: true });
    const events = await collect(loop.run("what is the key"));
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { type: "text"; text: string }).text)
      .join("");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  });
});

describe("M18 — replaceInProject is captured for /undo and the post-edit hook (#226)", () => {
  it("snapshots the match-set before the edit (so /undo restores) and reports changedPaths after", () => {
    const root = join(tmpdir(), `mm-rip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.ts"), "const OLDNAME = 1;");
    try {
      const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
      const priv = loop as unknown as {
        snapshotEdit: (t: number, n: string, i: Record<string, unknown>) => void;
        changedPaths: (n: string, i: Record<string, unknown>) => string[];
      };
      const input = { find: "OLDNAME", replace: "NEWNAME", isRegex: false };

      // Before the edit: snapshot captures a.ts (which contains "OLDNAME").
      priv.snapshotEdit(1, "replaceInProject", input);
      // The tool would now do the replace; simulate it.
      writeFileSync(join(root, "a.ts"), "const NEWNAME = 1;");

      // Post-edit hook gets the right changed path even though "OLDNAME" is gone.
      expect(priv.changedPaths("replaceInProject", input)).toEqual(["a.ts"]);

      // /undo restores the original content.
      expect(loop.undoLastEdit()).toMatch(/Revert|Undid|restored/i);
      expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const OLDNAME = 1;");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M18 — session auto-title (#227)", () => {
  it("titles a new session from the first user message", async () => {
    const root = join(tmpdir(), `mm-title-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() { yield { type: "text", text: "ok" }; yield { type: "done" }; },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);
    try {
      const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
      await loop.initPersistence({});
      await collect(loop.run("fix the auth bug please"));
      const sessions = loop.listSessions();
      expect(sessions[0].title).toBe("fix the auth bug please");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { handleRagCommand } from "../rag/manager.js";

describe("M18 — sub-agents get RAG context (#229)", () => {
  it("injects retrieved document context into the sub-agent's turn", async () => {
    // Force the offline hashing embedder so the test doesn't depend on (or hang on)
    // a locally-running ollama's embeddings endpoint.
    const prevEmbedder = process.env.METALMIND_EMBEDDER;
    process.env.METALMIND_EMBEDDER = "hashing";
    const root = join(tmpdir(), `mm-subrag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "auth.md"), "# Auth\nLogin uses a JWT token kept in a session cookie.");
    await handleRagCommand("add docs", root);

    const subMessages: Array<{ role: string; content: string }> = [];
    let calls = 0;
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "t1", toolName: "task", argumentsJson: JSON.stringify({ objective: "explain the jwt login flow" }) } };
          yield { type: "done" };
        } else if (calls === 2) {
          subMessages.push(...req.messages); // sub-agent turn
          yield { type: "text", text: "the jwt flow" };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        }
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    try {
      const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
      await collect(loop.run("delegate the auth investigation"));
      const sys = subMessages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      expect(sys).toContain("JWT token");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prevEmbedder === undefined) delete process.env.METALMIND_EMBEDDER;
      else process.env.METALMIND_EMBEDDER = prevEmbedder;
    }
  });
});

describe("M19 — clear error for a keyless cloud provider (#231)", () => {
  it("names the provider and env var instead of a cryptic failure", async () => {
    const loop = new AgentLoop({ provider: "anthropic", model: "claude", explicit: true }); // no apiKey
    await expect(collect(loop.run("hi"))).rejects.toThrow(/No API key for "anthropic".*ANTHROPIC_API_KEY/);
  });
});

describe("M20 — tier overrides apply during auto-routing (#235)", () => {
  let backup: string | null = null;
  beforeEach(() => { backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null; });
  afterEach(() => {
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("uses a setTierModel override even when the tier wasn't forced", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() { yield { type: "text", text: "ok" }; yield { type: "done" }; },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { router: new ModelRouter() });
    // Override every tier so whichever the router picks shows the override.
    loop.setTierModel(1, "ollama", "MY-OVERRIDE");
    loop.setTierModel(2, "ollama", "MY-OVERRIDE");
    loop.setTierModel(3, "ollama", "MY-OVERRIDE");
    await collect(loop.run("hi")); // auto-routed (not forced)
    expect(loop.getRoutingSummary()).toContain("MY-OVERRIDE");
  });
});

describe("M20 — compaction never orphans a tool_result (#237)", () => {
  it("snaps the boundary to a user turn and drops dangling tool messages", async () => {
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() { yield { type: "done" }; },
      async completeChat() { return { message: { role: "assistant" as const, content: "SUMMARY" } }; },
    } as never);
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true });
    // Build a history where a tool_call/tool_result pair sits right at the keep boundary.
    (loop as unknown as { history: unknown[] }).history = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", toolCalls: [{ toolCallId: "x", toolName: "readFile", argumentsJson: "{}" }] },
      { role: "tool", content: "tool-result", metadata: { toolCallId: "x" } },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];
    await loop.compactHistory();
    const hist = (loop as unknown as { history: Array<{ role: string; toolCalls?: unknown[] }> }).history;
    // No tool message should appear without a preceding assistant tool_call kept.
    hist.forEach((m, i) => {
      if (m.role === "tool") {
        expect(hist.slice(0, i).some((p) => p.role === "assistant" && (p.toolCalls?.length ?? 0) > 0)).toBe(true);
      }
    });
  });
});

describe("M21 — approval scope + audit redaction (#241, #238)", () => {
  it("'always allow' is scoped to the path — a different path still prompts (#241)", async () => {
    const fileA = join(tmpdir(), `mm-appr-a-${Date.now()}.txt`);
    const fileB = join(tmpdir(), `mm-appr-b-${Date.now()}.txt`);
    let n = 0;
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        n++;
        if (n === 1) { yield { type: "tool-call", toolCall: { toolCallId: "w1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: fileA, content: "a" }) } }; yield { type: "done" }; }
        else if (n === 2) { yield { type: "tool-call", toolCall: { toolCallId: "w2", toolName: "writeFile", argumentsJson: JSON.stringify({ path: fileB, content: "b" }) } }; yield { type: "done" }; }
        else { yield { type: "text", text: "done" }; yield { type: "done" }; }
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    const calls: string[] = [];
    const onApprovalRequest = async (req: { toolName: string }) => { calls.push(req.toolName); return "always" as const; };
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { onApprovalRequest });
    await collect(loop.run("write two files"));
    expect(calls.length).toBe(2); // not auto-approved for the 2nd path — scoped to the 1st
  });

  it("redacts secrets in tool inputs written to the audit log (#238)", async () => {
    const secret = "sk-audit-secret-1234567890";
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        let c = 0; c++;
        yield { type: "tool-call", toolCall: { toolCallId: "s1", toolName: "successTool", argumentsJson: JSON.stringify({ token: secret }) } };
        yield { type: "done" };
      },
      async completeChat() { return { message: { role: "assistant" as const, content: "" } }; },
    } as never);

    const onApprovalRequest = async () => "approve" as const;
    const loop = new AgentLoop({ provider: "stub", model: "test", apiKey: secret, explicit: true }, { onApprovalRequest });
    await collect(loop.run("call it"));
    const entries = loop.getAuditEntries();
    const e = entries.find((x) => x.toolName === "successTool");
    expect(JSON.stringify(e?.input)).not.toContain(secret);
    expect(JSON.stringify(e?.input)).toContain("[REDACTED]");
  });
});

describe("AgentLoop routing/display polish (#248)", () => {
  // setTierModel persists tierModels to the real XDG config — snapshot & restore
  // so this block can't leak overrides into other tests.
  let cfgBak: string | null = null;
  beforeEach(() => {
    vi.clearAllMocks();
    cfgBak = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null;
  });
  afterEach(() => {
    if (cfgBak !== null) writeFileSync(XDG_CONFIG_FILE, cfgBak);
  });

  it("discloses the tool-use iteration cap to the model on the final iteration", async () => {
    const root = join(tmpdir(), `mm-cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const seen: Array<Array<{ role: string; content: string }>> = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: 128000 } as never,
      async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
        seen.push(req.messages);
        // Always ask for a read-only tool so the loop runs to the iteration cap.
        yield { type: "tool-call", toolCall: { toolCallId: `t${seen.length}`, toolName: "readFile", argumentsJson: JSON.stringify({ path: "a.ts" }) } };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    loop.setForcedTier(3); // deterministic route, no triage/network
    await collect(loop.run("keep reading"));

    const hasCap = (msgs: Array<{ role: string; content: string }>) =>
      msgs.some((m) => m.role === "system" && /final tool-use iteration/i.test(m.content));
    // The first request has no cap notice; the last one does.
    expect(hasCap(seen[0])).toBe(false);
    expect(hasCap(seen[seen.length - 1])).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("carries a per-tier baseUrl override through to the provider (#248)", async () => {
    const root = join(tmpdir(), `mm-tierurl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const captured: Array<{ provider: string; model: string; baseUrl?: string }> = [];
    mockCreateProvider.mockImplementation((provider: string, model: string, opts?: { baseUrl?: string }) => {
      captured.push({ provider, model, baseUrl: opts?.baseUrl });
      return makeProvider([{ type: "text", text: "ok" }, { type: "done" }]) as never;
    });

    const router = new ModelRouter({
      tier1Model: "local-small", tier1Provider: "mlx",
      tier2Model: "local-small", tier2Provider: "mlx",
      tier3Model: "claude", tier3Provider: "anthropic",
      localFirst: true,
    });
    const loop = new AgentLoop({ provider: "mlx", model: "local-small", explicit: false }, { projectRoot: root, router });
    loop.setTierModel(3, "ollama-cloud", "gemini-3-flash-preview:cloud", "http://custom-host:9999");
    loop.setForcedTier(3);
    await collect(loop.run("hello"));

    expect(
      captured.some(
        (c) => c.provider === "ollama-cloud" && c.model === "gemini-3-flash-preview:cloud" && c.baseUrl === "http://custom-host:9999",
      ),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentLoop Build/Plan mode (#11)", () => {
  beforeEach(() => vi.clearAllMocks());

  function writeThenDone(path: string) {
    let calls = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "w1", toolName: "writeFile", argumentsJson: JSON.stringify({ path, content: "hi" }) } };
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

  it("plan mode refuses mutating tools without executing them", async () => {
    const root = join(tmpdir(), `mm-plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const f = join(root, "x.ts");
    mockCreateProvider.mockReturnValue(writeThenDone(f));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    loop.setMode("plan");
    expect(loop.getMode()).toBe("plan");
    const events = await collect(loop.run("write the file"));

    expect(existsSync(f)).toBe(false); // refused, not executed
    const result = events.find((e) => e.type === "tool-result") as { output?: string } | undefined;
    expect(result?.output).toMatch(/plan mode/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("build mode (default) executes mutating tools", async () => {
    const root = join(tmpdir(), `mm-build-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const f = join(root, "y.ts");
    mockCreateProvider.mockReturnValue(writeThenDone(f));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    expect(loop.getMode()).toBe("build");
    await collect(loop.run("write the file"));

    expect(existsSync(f)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentLoop @-mention context is per-turn, not persisted (#260)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("injects the mentioned file into the request but not into saved history, and does not accumulate", async () => {
    const root = join(tmpdir(), `mm-mention-ctx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const MENTION_MARKER = 1;");

    const seen: Array<Array<{ role: string; content: string }>> = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: 128000 } as never,
      async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
        seen.push(req.messages);
        yield { type: "text", text: "ok" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("look at @src/a.ts"));

    // The model saw the mentioned file content this turn...
    const firstReq = seen[0].map((m) => m.content).join("\n");
    expect(firstReq).toContain("MENTION_MARKER");
    // ...but it was NOT written into persisted history.
    const histAfter1 = loop.conversation().map((m) => m.content).join("\n");
    expect(histAfter1).not.toContain("MENTION_MARKER");

    // A second turn (no mention) must not re-include it, and history must not have grown a stale copy.
    await collect(loop.run("and now something else"));
    const secondReq = seen[1].map((m) => m.content).join("\n");
    expect(secondReq).not.toContain("MENTION_MARKER");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("Stale re-reads are superseded in history (#290)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shrinks the earlier readFile result when the same path is read again", async () => {
    const root = join(tmpdir(), `mm-290-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    let calls = 0;
    const seen: Array<Array<{ role: string; content: string }>> = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
        seen.push(req.messages);
        calls++;
        if (calls === 1 || calls === 3) {
          yield { type: "tool-call", toolCall: { toolCallId: `r${calls}`, toolName: "readFile", argumentsJson: JSON.stringify({ path: "a.ts" }) } };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "ok" };
          yield { type: "done" };
        }
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("read it"));
    await collect(loop.run("read it again"));

    // The request AFTER the second read (calls===4) sees the stub in place of the
    // first read and exactly one full copy of the file content.
    const lastReq = seen.at(-1)!;
    const toolContents = lastReq.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolContents.some((c) => /stale read .*a\.ts.* superseded/.test(c))).toBe(true);
    expect(toolContents.filter((c) => c.includes("read:a.ts")).length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("System prompt refresh after edits (#302)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rebuilds the system prompt on the turn after a file edit", async () => {
    const root = join(tmpdir(), `mm-302-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    // The agent writes AGENTS.md (project instructions feed the system prompt
    // via loadProjectMemory, which is NOT mocked) — the rebuilt prompt must
    // contain the new rule on the following turn.
    const f = join(root, "AGENTS.md");
    let calls = 0;
    const seen: Array<Array<{ role: string; content: string }>> = [];
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: 128000 } as never,
      async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
        seen.push(req.messages);
        calls++;
        if (calls === 1) {
          yield { type: "tool-call", toolCall: { toolCallId: "w1", toolName: "writeFile", argumentsJson: JSON.stringify({ path: f, content: "RULE-302-MARKER: always use tabs" }) } };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        }
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("create the instructions file"));
    expect(seen[0][0].content).not.toContain("RULE-302-MARKER");
    await collect(loop.run("now what?"));
    // The prompt was rebuilt after the edit, so the new instructions are in it.
    expect(seen.at(-1)![0].role).toBe("system");
    expect(seen.at(-1)![0].content).toContain("RULE-302-MARKER");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("Turn context reaches quality-gated router attempts (#289)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes the @-mention block in a routed (collectAttempt) request", async () => {
    const root = join(tmpdir(), `mm-289-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const CTX_MARKER_289 = true;");

    const seen: Array<Array<{ role: string; content: string }>> = [];
    mockCreateProvider.mockImplementation(() => ({
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: 128000 } as never,
      async *streamChatCompletion(req: { messages: Array<{ role: string; content: string }> }) {
        seen.push(req.messages);
        yield { type: "text", text: "a clear, sufficient answer" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "SIMPLE" } };
      },
    }) as never);

    const router = new ModelRouter({
      tier1Model: "local-small", tier1Provider: "mlx",
      tier2Model: "local-small", tier2Provider: "mlx",
      tier3Model: "claude", tier3Provider: "anthropic",
      localFirst: true,
    });
    const loop = new AgentLoop({ provider: "mlx", model: "local-small", explicit: false }, { projectRoot: root, router });
    await collect(loop.run("explain @src/a.ts conceptually"));

    // The routed attempt goes through collectAttempt — it must carry the mention.
    const firstReq = seen[0]?.map((m) => m.content).join("\n") ?? "";
    expect(firstReq).toContain("CTX_MARKER_289");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("AgentLoop auto-compact near the context window (#273)", () => {
  beforeEach(() => vi.clearAllMocks());

  function bigTextProvider(maxTokens: number, chunk: string) {
    return {
      providerName: "stub",
      supportedCapabilities: { maximumContextTokens: maxTokens } as never,
      async *streamChatCompletion() {
        yield { type: "text", text: chunk };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "SUMMARY-MARKER: earlier work condensed." } };
      },
    } as never;
  }

  it("summarizes older turns automatically instead of only dropping them", async () => {
    const root = join(tmpdir(), `mm-autocompact-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    // Window 6000 → budget 6000-2048=3952 → auto-compact fires at ~3557 tokens.
    // ~600 tokens/turn (2400 chars) so the message COUNT clears compactHistory's
    // minimum (KEEP_RECENT+2) well before the token threshold is crossed.
    mockCreateProvider.mockReturnValue(bigTextProvider(6000, "x".repeat(2400)));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const texts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const events = await collect(loop.run(`turn ${i}: continue the work`));
      texts.push(...events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text));
    }

    // Auto-compact announced itself...
    expect(texts.some((t) => t.includes("[auto-compact]"))).toBe(true);
    // ...and the summary actually replaced older turns in history.
    const hist = loop.conversation();
    expect(hist.some((m) => m.content.includes("SUMMARY-MARKER"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not compact a short conversation", async () => {
    const root = join(tmpdir(), `mm-nocompact-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    mockCreateProvider.mockReturnValue(bigTextProvider(128_000, "short answer"));

    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const events = await collect(loop.run("hello"));
    const texts = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text);
    expect(texts.some((t) => t.includes("[auto-compact]"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("M28 — agentic dev workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  function textProvider(reply: string) {
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        yield { type: "text", text: "ok" };
        yield { type: "done" };
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: reply } };
      },
    } as never;
  }

  it("/commit flow stages, generates a message, and commits (#274)", async () => {
    const root = join(tmpdir(), `mm-commit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    mockCreateProvider.mockReturnValue(textProvider("feat: add the new thing\n\nDetails about why."));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const result = await loop.commitFlow();
    expect(result).toContain("Committed:");
    expect(result).toContain("feat: add the new thing");
    expect(result).toContain("[main abc123]");
    rmSync(root, { recursive: true, force: true });
  });

  it("/pr flow pushes and creates a PR with a generated title (#275)", async () => {
    const root = join(tmpdir(), `mm-pr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    mockCreateProvider.mockReturnValue(textProvider("TITLE: Add the new thing\nBODY:\n- adds it"));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const result = await loop.prFlow();
    expect(result).toContain("PR created:");
    expect(result).toContain("pull/7");
    rmSync(root, { recursive: true, force: true });
  });

  it("/test flow runs tests and reports the result (#295)", async () => {
    const root = join(tmpdir(), `mm-verify-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    mockCreateProvider.mockReturnValue(textProvider(""));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    const result = await loop.verifyFlow("test");
    expect(result).toContain("Tests passed");
    rmSync(root, { recursive: true, force: true });
  });

  it("setTodos updates the task list and notifies the UI (#276)", async () => {
    const root = join(tmpdir(), `mm-todos-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    let calls = 0;
    mockCreateProvider.mockReturnValue({
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        calls++;
        if (calls === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              toolCallId: "t1",
              toolName: "setTodos",
              argumentsJson: JSON.stringify({
                todos: [
                  { text: "step one", status: "completed" },
                  { text: "step two", status: "in_progress" },
                  { text: "step three", status: "pending" },
                ],
              }),
            },
          };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        }
      },
      async completeChat() {
        return { message: { role: "assistant" as const, content: "" } };
      },
    } as never);

    const updates: Array<Array<{ text: string; status: string }>> = [];
    const loop = new AgentLoop(
      { provider: "stub", model: "test", explicit: true },
      { projectRoot: root, onTodos: (t) => updates.push(t) },
    );
    const events = await collect(loop.run("do the multi-step thing"));
    expect(updates).toHaveLength(1);
    expect(updates[0].map((t) => t.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(loop.getTodos()).toHaveLength(3);
    const result = events.find((e) => e.type === "tool-result") as { output?: string } | undefined;
    expect(result?.output).toContain("1/3 completed");
    rmSync(root, { recursive: true, force: true });
  });

  it("git checkpoint is taken before the first mutating tool and /rollback restores it (#297)", async () => {
    const root = join(tmpdir(), `mm-ckpt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(root, { recursive: true });
    const { execSync } = await import("node:child_process");
    execSync("git init -b main && git config user.email t@t && git config user.name T", { cwd: root });
    const f = join(root, "tracked.ts");
    writeFileSync(f, "ORIGINAL CONTENT");
    execSync("git add -A && git commit -m init", { cwd: root });

    mockCreateProvider.mockReturnValue(toolThenDoneProviderFor("writeFile", { path: f, content: "MODIFIED BY AGENT" }));
    const loop = new AgentLoop({ provider: "stub", model: "test", explicit: true }, { projectRoot: root });
    await collect(loop.run("modify the file"));

    expect(readFileSync(f, "utf-8")).toBe("MODIFIED BY AGENT");
    expect(loop.listCheckpoints()).toContain("turn 1");

    const report = loop.rollbackToCheckpoint();
    expect(report).toContain("Restored");
    expect(readFileSync(f, "utf-8")).toBe("ORIGINAL CONTENT");
    rmSync(root, { recursive: true, force: true });
  });

  function toolThenDoneProviderFor(toolName: string, args: Record<string, unknown>) {
    let n = 0;
    return {
      providerName: "stub",
      supportedCapabilities: {} as never,
      async *streamChatCompletion() {
        n++;
        if (n === 1) {
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
});
