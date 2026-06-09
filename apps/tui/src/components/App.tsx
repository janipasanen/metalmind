import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Header from "./Header.js";
import ChatView from "./ChatView.js";
import InputBar from "./InputBar.js";
import StatusBar from "./StatusBar.js";
import MultiAgentStatus from "./MultiAgentStatus.js";
import { useChat } from "../hooks/useChat.js";
import { AgentLoop, createDefaultRouter, type ForcedTier, type ApprovalRequest, type ApprovalDecision } from "../agent.js";
import ApprovalView from "./ApprovalView.js";
import type { TuiConfig } from "../config.js";
import { Coordinator, SafetyValidator } from "@metalmind/core";
import type { WorkerProvider } from "@metalmind/core";
import type { CoordinatorPhase, PlanStep } from "@metalmind/core";
import type { ModelRoutingDecision } from "@metalmind/schemas";
import CommandPalette from "./CommandPalette.js";
import ProviderSelection from "./ProviderSelection.js";
import ModelSelection from "./ModelSelection.js";
import McpConfig from "./McpConfig.js";
import ThemeSelection from "./ThemeSelection.js";
import TierModelPicker from "./TierModelPicker.js";
import { loadXdgConfig, saveXdgConfig, switchTheme, loadTheme } from "@metalmind/config";
import { resolveConfig } from "../config.js";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: Array<{
    id: string;
    toolName: string;
    argumentsJson: string;
    output?: string;
  }>;
  timestamp: Date;
}

interface AppProps {
  config: TuiConfig;
}

/** Convert restored persisted messages into chat-view messages (#140). */
function restoredToChatMessages(msgs: Array<{ role: string; content: string }>): ChatMessage[] {
  return msgs.map((m, i) => ({
    id: `restored-${i}`,
    role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
    content: m.content,
    timestamp: new Date(),
  }));
}

export default function App({ config }: AppProps) {
  const [activeProvider, setActiveProvider] = useState(config.provider);
  const [activeModel, setActiveModel] = useState<string>(`${config.provider}/${config.model}`);
  const [focusPanel, setFocusPanel] = useState<"chat" | "input">("input");
  const [projectName] = useState(() => {
    const parts = process.cwd().split("/");
    return parts[parts.length - 1] || "metalmind";
  });
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showProviderSelection, setShowProviderSelection] = useState(false);
  const [showModelSelection, setShowModelSelection] = useState(false);
  const [showMcpConfig, setShowMcpConfig] = useState(false);
  const [showThemeSelection, setShowThemeSelection] = useState(false);
  const [theme, setTheme] = useState(() => loadTheme());
  const [forcedTier, setForcedTierState] = useState<ForcedTier>(null);
  const [tierModelPickerFor, setTierModelPickerFor] = useState<1 | 2 | 3 | null>(null);
  const [tierModels, setTierModels] = useState<Record<number, { provider: string; model: string }>>({});

  const applyForcedTier = useCallback((tier: ForcedTier) => {
    setForcedTierState(tier);
    agentRef.current?.setForcedTier(tier);
  }, []);

  const applyTierModel = useCallback((tier: 1 | 2 | 3, provider: string, model: string) => {
    agentRef.current?.setTierModel(tier, provider, model);
    setTierModels(prev => ({ ...prev, [tier]: { provider, model } }));
    // Also force that tier so the new model is used immediately.
    applyForcedTier(tier);
  }, [applyForcedTier]);

  const agentRef = useRef<AgentLoop | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [coordinatorPhase, setCoordinatorPhase] = useState<CoordinatorPhase>("idle");
  const [currentRouting, setCurrentRouting] = useState<ModelRoutingDecision | undefined>(undefined);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [contextUsage, setContextUsage] = useState<{ used: number; limit: number } | undefined>(undefined);
  const [pendingApproval, setPendingApproval] = useState<{ req: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | undefined>(undefined);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [localWorkerModel, _setLocalWorkerModel] = useState<string | undefined>(undefined);
  const [localWorkerProvider, _setLocalWorkerProvider] = useState<string | undefined>(undefined);
  const [localWorkerAvailable, setLocalWorkerAvailable] = useState(false);

  const reloadAgent = useCallback(async () => {
    let cancelled = false;

    (async () => {
      try {
        const currentConfig = resolveConfig();
        const router = currentConfig.explicit ? undefined : await createDefaultRouter(currentConfig);
        if (cancelled) return;
        if (agentRef.current) agentRef.current.clearHistory();
        const agent = new AgentLoop(currentConfig, {
          router,
          onRoute: (d) => setActiveModel(`${d.provider}/${d.modelId} [${d.tier}]`),
          onCoordinatorPhase: (phase) => setCoordinatorPhase(phase),
          onCoordinatorRouting: (decision) => setCurrentRouting(decision),
          onCoordinatorPlan: (steps) => setPlanSteps(steps),
          onContextUsage: (used, limit) => setContextUsage({ used, limit }),
          onApprovalRequest: (req) =>
            new Promise<ApprovalDecision>((resolve) => setPendingApproval({ req, resolve })),
          onUsage: (u) => setUsage(u),
        });
        await agent.initMcp();
        await agent.initCoordinator();
        if (cancelled) return;
        agentRef.current = agent;
        await agent.initPersistence({}); // reconfigure → fresh persisted session
        setAgentError(null);

        const coordinator = agent.coordinatorInstance;
        if (coordinator) {
          const wp = coordinator.getRunner();
          const providerField = (wp as unknown as { provider: WorkerProvider | null }).provider;
          if (providerField) {
            _setLocalWorkerProvider(providerField.providerName);
            setLocalWorkerAvailable(true);
          }
        }
      } catch (err) {
        if (!cancelled) setAgentError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const router = config.explicit ? undefined : await createDefaultRouter(config);
        if (cancelled) return;
        const agent = new AgentLoop(config, {
          router,
          onRoute: (d) => setActiveModel(`${d.provider}/${d.modelId} [${d.tier}]`),
          onCoordinatorPhase: (phase) => setCoordinatorPhase(phase),
          onCoordinatorRouting: (decision) => setCurrentRouting(decision),
          onCoordinatorPlan: (steps) => setPlanSteps(steps),
          onContextUsage: (used, limit) => setContextUsage({ used, limit }),
          onApprovalRequest: (req) =>
            new Promise<ApprovalDecision>((resolve) => setPendingApproval({ req, resolve })),
          onUsage: (u) => setUsage(u),
        });
        await agent.initMcp();
        await agent.initCoordinator();
        if (cancelled) return;
        agentRef.current = agent;

        // Open persistence and resume if --continue/--resume was passed (#140).
        const restored = await agent.initPersistence({
          continue: config.continueSession,
          resumeId: config.resumeSessionId,
        });
        if (!cancelled && restored.length > 0) {
          replaceMessages(restoredToChatMessages(restored));
        }

        // Non-blocking pre-flight: warn up front on a bad key/missing model (#174).
        void agent.checkHealth().then((h) => {
          if (!cancelled) setHealthWarning(h.ok ? null : h.message);
        });

        const coordinator = agent.coordinatorInstance;
        if (coordinator) {
          const wp = coordinator.getRunner();
          const providerField = (wp as unknown as { provider: WorkerProvider | null }).provider;
          if (providerField) {
            _setLocalWorkerProvider(providerField.providerName);
            setLocalWorkerAvailable(true);
          }
        }
      } catch (err) {
        if (!cancelled) setAgentError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config]);

  const { messages, sendMessage, isStreaming, streamingContent, activeToolCalls, cancelStream, replaceMessages } = useChat({
    generateResponse: async function* (input: string, signal?: AbortSignal) {
      if (input === "/help") {
        yield { type: "text", text: [
          "Available commands:",
          "  /help             - Show this help",
          "  /tier 1|2|3|auto [model]  - Force a tier; optional model overrides default",
          "    Examples:",
          "      /tier 3                       force cloud (keep current model)",
          "      /tier 3 gemma4:31b-cloud       force cloud + switch to gemma4:31b",
          "      /tier 3 devstral-2:123b-cloud  force cloud + switch to devstral 123B",
          "      /tier auto                     restore automatic routing",
          "    Ctrl+P → Tier 1/2/3 to pick from a model list interactively",
          "  /model <name>     - Switch model (e.g. /model gemma3:27b)",
          "  /apikey <key>     - Update API key for current provider",
          "  /workspace <path> - Allow AI to access an additional directory",
          "  /init             - Generate a starter project memory file (.metalmind/MEMORY.md)",
          "  /skill            - list | activate <name> | deactivate <name>",
          "  /resume [id]      - List saved sessions, or resume one by id (also --continue/--resume on launch)",
          "  /compact          - Summarize older turns to reclaim context window",
          "  /export [md|json] - Export the conversation transcript to a file",
          "  /cost             - Show this session's token usage",
          "  /routes           - Show routing decisions + per-tier hit counts",
          "  /undo             - Revert the agent's last edit set (repeatable)",
          "  /redo             - Re-apply the most recently undone edit set",
          "  /audit            - Show this session's tool-call log",
          "  /clear            - Clear chat history",
          "  /quit             - Exit",
          "",
          "Ctrl+P            - Open command palette (tier, provider, model, theme, MCP)",
        ].join("\n") } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/quit") {
        agentRef.current?.dispose();
        yield { type: "done" } as const;
        process.exit(0);
      }

      if (input === "/clear") {
        // Start a new persisted session rather than destroying history (#140).
        agentRef.current?.newSession();
        yield { type: "done" } as const;
        return;
      }

      if (input === "/resume" || input.startsWith("/resume ")) {
        const id = input.slice(7).trim();
        const agent = agentRef.current;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else if (!id) {
          const sessions = agent.listSessions();
          if (sessions.length === 0) {
            yield { type: "text", text: "No saved sessions yet." } as const;
          } else {
            const lines = sessions
              .slice(0, 15)
              .map((s) => `  ${s.id}  (updated ${s.updated_at})${s.title ? ` — ${s.title}` : ""}`);
            yield { type: "text", text: `Recent sessions — resume with /resume <id>:\n${lines.join("\n")}` } as const;
          }
        } else {
          const restored = agent.resumeSession(id);
          replaceMessages(restoredToChatMessages(restored));
          yield { type: "text", text: `Resumed session ${id} (${restored.length} messages).` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/undo") {
        const report = agentRef.current?.undoLastEdit() ?? "Agent not initialised.";
        yield { type: "text", text: report } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/redo") {
        const report = agentRef.current?.redoLastEdit() ?? "Agent not initialised.";
        yield { type: "text", text: report } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/compact") {
        const msg = (await agentRef.current?.compactHistory()) ?? "Agent not initialised.";
        yield { type: "text", text: msg } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/export" || input.startsWith("/export ")) {
        const fmt = input.slice(7).trim().toLowerCase() === "json" ? "json" : "md";
        const path = agentRef.current?.exportTranscript(fmt as "md" | "json");
        yield { type: "text", text: path ? `Exported transcript to ${path}` : "Agent not initialised." } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/init") {
        const report = agentRef.current?.initProjectDoc() ?? "Agent not initialised.";
        yield { type: "text", text: report } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/skill" || input.startsWith("/skill ")) {
        const rest = input.slice(6).trim();
        const [sub, ...nameParts] = rest.split(/\s+/);
        const name = nameParts.join(" ");
        const agent = agentRef.current;
        let text: string;
        if (!agent) text = "Agent not initialised.";
        else if (!sub || sub === "list") text = agent.listSkills();
        else if (sub === "activate" && name) text = agent.activateSkill(name);
        else if (sub === "deactivate" && name) text = agent.deactivateSkill(name);
        else text = "Usage: /skill list | /skill activate <name> | /skill deactivate <name>";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/cost") {
        const u = agentRef.current?.getSessionUsage();
        const text = u
          ? `Session token usage:\n  input:  ${u.inputTokens.toLocaleString()}\n  output: ${u.outputTokens.toLocaleString()}\n  total:  ${(u.inputTokens + u.outputTokens).toLocaleString()}`
          : "Agent not initialised.";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/routes") {
        const text = agentRef.current?.getRoutingSummary() ?? "Agent not initialised.";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/audit") {
        const entries = agentRef.current?.getAuditEntries() ?? [];
        if (entries.length === 0) {
          yield { type: "text", text: "No tool calls recorded yet this session." } as const;
        } else {
          const lines = entries.map((e) => {
            const status = e.success ? "✓" : "✗";
            const inputSummary = JSON.stringify(e.input).slice(0, 80);
            const errSuffix = e.error ? `  — ${e.error}` : "";
            return `${status} ${e.toolName}(${inputSummary})${errSuffix}`;
          });
          yield { type: "text", text: `Tool-call audit (last ${entries.length}):\n${lines.join("\n")}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input.startsWith("/workspace ")) {
        const wsPath = input.slice(11).trim();
        if (!wsPath) {
          yield { type: "text", text: "Usage: /workspace <absolute-path>" } as const;
          yield { type: "done" } as const;
          return;
        }
        agentRef.current?.addWorkspaceRoot(wsPath);
        yield { type: "text", text: `Workspace added: ${wsPath}\nThe AI can now read files from that directory.` } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input.startsWith("/tier")) {
        // Supports:
        //   /tier 3                        → force tier 3, keep current model
        //   /tier 3 gemma4:31b-cloud       → force tier 3 AND override model
        //   /tier auto                     → restore automatic routing
        const raw = input.slice(5).trim();
        const parts = raw.split(/\s+/);
        const tierArg = parts[0]?.toLowerCase() ?? "";
        const modelArg = parts.slice(1).join(" ").trim(); // everything after the tier number

        const tierMap: Record<string, ForcedTier> = { "1": 1, "2": 2, "3": 3, "auto": null };
        const providerMap: Record<number, string> = { 1: "mlx", 2: "ollama", 3: "ollama-cloud" };

        if (!(tierArg in tierMap)) {
          yield { type: "text", text: "Usage: /tier 1|2|3|auto [model-name]" } as const;
          yield { type: "done" } as const;
          return;
        }

        const tier = tierMap[tierArg];
        applyForcedTier(tier);

        if (tier !== null && modelArg) {
          const provider = providerMap[tier];
          applyTierModel(tier, provider, modelArg);
          yield { type: "text", text: `✓ Tier ${tier} forced — model: ${provider}/${modelArg}` } as const;
        } else if (tier === null) {
          yield { type: "text", text: "✓ Auto-routing restored" } as const;
        } else {
          const tierNames: Record<number, string> = { 1: "MLX GPU", 2: "local Ollama", 3: "Ollama Cloud" };
          yield { type: "text", text: `✓ Tier ${tier} forced (${tierNames[tier]}) — use /tier ${tier} <model> to also override the model` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input.startsWith("/apikey ")) {
        const newKey = input.slice(8).trim();
        if (!newKey) {
          yield { type: "text", text: "Usage: /apikey <key>" } as const;
          yield { type: "done" } as const;
          return;
        }
        const cfg = loadXdgConfig();
        saveXdgConfig({ ...cfg, apiKeys: { ...cfg.apiKeys, [activeProvider]: newKey } });
        reloadAgent();
        yield { type: "text", text: `API key updated for ${activeProvider} (${newKey.slice(0, 8)}...)` } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input.startsWith("/model ")) {
        // Strip optional "provider/" prefix so "/model ollama/foo" and "/model foo" both work.
        let newModel = input.slice(7).trim();
        const slash = newModel.indexOf("/");
        if (slash !== -1 && newModel.slice(0, slash) === activeProvider) {
          newModel = newModel.slice(slash + 1);
        }
        const cfg = loadXdgConfig();
        saveXdgConfig({ ...cfg, activeModel: newModel });
        setActiveModel(`${activeProvider}/${newModel}`);
        reloadAgent();
        yield { type: "text", text: `Switched to model: ${activeProvider}/${newModel}` } as const;
        yield { type: "done" } as const;
        return;
      }

      if (!agentRef.current) {
        yield { type: "error", message: agentError ?? "Agent not initialised — check provider config." } as const;
        yield { type: "done" } as const;
        return;
      }

      yield* agentRef.current.run(input, signal);
    },
  });

  const handleSend = useCallback((text: string) => sendMessage(text), [sendMessage]);

  useInput((input, key) => {
    // Approval prompt takes priority over all other input while it's open (#138).
    if (pendingApproval) {
      if (input === "y" || key.return) {
        pendingApproval.resolve("approve");
        setPendingApproval(null);
      } else if (input === "a") {
        pendingApproval.resolve("always");
        setPendingApproval(null);
      } else if (input === "n" || key.escape) {
        pendingApproval.resolve("reject");
        setPendingApproval(null);
      }
      return;
    }
    // Esc during a stream aborts the in-flight turn (truthful to the StatusBar hint).
    if (key.escape && isStreaming) {
      cancelStream();
      return;
    }
    if (key.tab) setFocusPanel(prev => prev === "chat" ? "input" : "chat");
    if (key.ctrl && input === "p") setShowCommandPalette(prev => !prev);
  });

  const getActiveModel = () => {
    if (forcedTier !== null) {
      const override = tierModels[forcedTier];
      const modelLabel = override ? `${override.provider}/${override.model}` : activeModel;
      const tierSuffix = ` [tier${forcedTier} locked]`;
      return modelLabel + tierSuffix;
    }
    return activeModel;
  };

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName={projectName} modelName={getActiveModel()} accent={theme.colors.accent} />
      <ChatView messages={messages} streamingContent={streamingContent} activeToolCalls={activeToolCalls} isStreaming={isStreaming} accent={theme.colors.accent} />
      <MultiAgentStatus
        mainModel={config.model}
        mainProvider={config.provider}
        localWorkerModel={localWorkerModel}
        localWorkerProvider={localWorkerProvider}
        localWorkerAvailable={localWorkerAvailable}
        phase={coordinatorPhase}
        currentRouting={currentRouting}
        planSteps={planSteps}
      />
      {healthWarning && (
        <Box>
          <Text color="yellow">⚠ {healthWarning}</Text>
        </Box>
      )}
      {pendingApproval && <ApprovalView req={pendingApproval.req} accent={theme.colors.accent} />}
      <InputBar onSubmit={handleSend} disabled={isStreaming || pendingApproval !== null} />
      <StatusBar focusPanel={focusPanel} isStreaming={isStreaming} context={contextUsage} usage={usage} />

      {showCommandPalette && (
        <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} accent={theme.colors.accent}
          commands={[
            { id: "tier-auto", title: "Tier: Auto", description: "Let router pick tier per request", action: () => applyForcedTier(null) },
            { id: "tier-1", title: "Tier 1: MLX GPU", description: "Choose + force local MLX model", action: () => setTierModelPickerFor(1) },
            { id: "tier-2", title: "Tier 2: Local Ollama", description: "Choose + force local Ollama model", action: () => setTierModelPickerFor(2) },
            { id: "tier-3", title: "Tier 3: Cloud brain", description: "Choose + force Ollama Cloud model", action: () => setTierModelPickerFor(3) },
            { id: "provider", title: "Remote Provider", description: "Cloud provider for complex tasks", action: () => setShowProviderSelection(true) },
            { id: "model", title: "Remote Model", description: "Model used for complex tasks", action: () => setShowModelSelection(true) },
            { id: "mcp", title: "MCP", description: "Configure MCP servers", action: () => setShowMcpConfig(true) },
            { id: "theme", title: "Theme", description: "Switch theme (light/dark)", action: () => setShowThemeSelection(true) },
          ]}
        />
      )}
      {showProviderSelection && (
        <ProviderSelection onSelect={async (providerId) => {
          setShowProviderSelection(false);
          setActiveProvider(providerId);
          const newCfg = resolveConfig();
          setActiveModel(`${newCfg.provider}/${newCfg.model}`);
          await reloadAgent();
        }} onCancel={() => setShowProviderSelection(false)} accent={theme.colors.accent} />
      )}
      {showModelSelection && (
        <ModelSelection providerId={activeProvider} onSelect={async (modelId) => {
          setShowModelSelection(false);
          setActiveModel(`${activeProvider}/${modelId}`);
          await reloadAgent();
        }} onCancel={() => setShowModelSelection(false)} accent={theme.colors.accent} />
      )}
      {showMcpConfig && <McpConfig onDone={() => setShowMcpConfig(false)} accent={theme.colors.accent} />}
      {tierModelPickerFor !== null && (
        <TierModelPicker
          tier={tierModelPickerFor}
          currentModel={tierModels[tierModelPickerFor]?.model}
          onSelect={(provider, model) => {
            applyTierModel(tierModelPickerFor, provider, model);
            setTierModelPickerFor(null);
          }}
          onCancel={() => setTierModelPickerFor(null)}
          accent={theme.colors.accent}
        />
      )}
      {showThemeSelection && (
        <ThemeSelection currentTheme={theme.id} onSelect={async (themeId) => {
          const newTheme = switchTheme(themeId);
          setTheme(newTheme);
          setShowThemeSelection(false);
          const currentConfig = loadXdgConfig();
          saveXdgConfig({ ...currentConfig, uiTheme: themeId as "light" | "dark" | "system" });
        }} onCancel={() => setShowThemeSelection(false)} accent={theme.colors.accent} />
      )}
    </Box>
  );
}
