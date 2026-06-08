import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Header from "./Header.js";
import ChatView from "./ChatView.js";
import InputBar from "./InputBar.js";
import StatusBar from "./StatusBar.js";
import MultiAgentStatus from "./MultiAgentStatus.js";
import { useChat } from "../hooks/useChat.js";
import { AgentLoop, createDefaultRouter, type ForcedTier } from "../agent.js";
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
        });
        await agent.initMcp();
        await agent.initCoordinator();
        if (cancelled) return;
        agentRef.current = agent;
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
        });
        await agent.initMcp();
        await agent.initCoordinator();
        if (cancelled) return;
        agentRef.current = agent;

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

  const { messages, sendMessage, isStreaming, streamingContent, activeToolCalls, cancelStream } = useChat({
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
          "  /undo             - Revert the agent's last applied edit set",
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
        yield { type: "done" } as const;
        process.exit(0);
      }

      if (input === "/clear") {
        agentRef.current?.clearHistory();
        yield { type: "done" } as const;
        return;
      }

      if (input === "/undo") {
        const report = agentRef.current?.undoLastEdit() ?? "Agent not initialised.";
        yield { type: "text", text: report } as const;
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
      <InputBar onSubmit={handleSend} disabled={isStreaming} />
      <StatusBar focusPanel={focusPanel} isStreaming={isStreaming} />

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
