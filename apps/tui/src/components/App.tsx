import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Header from "./Header.js";
import ChatView from "./ChatView.js";
import InputBar from "./InputBar.js";
import StatusBar from "./StatusBar.js";
import { useChat } from "../hooks/useChat.js";
import { AgentLoop, createDefaultRouter } from "../agent.js";
import type { TuiConfig } from "../config.js";
import CommandPalette from "./CommandPalette.js";
import ProviderSelection from "./ProviderSelection.js";
import ModelSelection from "./ModelSelection.js";
import McpConfig from "./McpConfig.js";
import ThemeSelection from "./ThemeSelection.js";
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

  const agentRef = useRef<AgentLoop | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const reloadAgent = useCallback(async () => {
    let cancelled = false;

    (async () => {
      try {
        const currentConfig = resolveConfig();
        const router = currentConfig.explicit ? undefined : await createDefaultRouter(currentConfig);
        if (cancelled) return;
        if (agentRef.current) agentRef.current.clearHistory();
        agentRef.current = new AgentLoop(currentConfig, {
          router,
          onRoute: (d) => setActiveModel(`${d.provider}/${d.modelId} [${d.tier}]`),
        });
        setAgentError(null);
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
        agentRef.current = new AgentLoop(config, {
          router,
          onRoute: (d) => setActiveModel(`${d.provider}/${d.modelId} [${d.tier}]`),
        });
      } catch (err) {
        if (!cancelled) setAgentError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config]);

  const { messages, sendMessage, isStreaming, streamingContent, activeToolCalls } = useChat({
    generateResponse: async function* (input: string) {
      if (input === "/help") {
        yield { type: "text", text: "Available commands:\n  /help - Show this help\n  /model <name> - Switch model\n  /clear - Clear chat\n  /quit - Exit" } as const;
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

      yield* agentRef.current.run(input);
    },
  });

  const handleSend = useCallback((text: string) => sendMessage(text), [sendMessage]);

  useInput((input, key) => {
    if (key.tab) setFocusPanel(prev => prev === "chat" ? "input" : "chat");
    if (key.ctrl && input === "p") setShowCommandPalette(prev => !prev);
  });

  const getActiveModel = () => activeModel;

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName={projectName} modelName={getActiveModel()} />
      <ChatView messages={messages} streamingContent={streamingContent} activeToolCalls={activeToolCalls} isStreaming={isStreaming} />
      <InputBar onSubmit={handleSend} disabled={isStreaming} />
      <StatusBar focusPanel={focusPanel} isStreaming={isStreaming} />
      
      {showCommandPalette && (
        <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} 
          commands={[
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
        }} onCancel={() => setShowProviderSelection(false)} />
      )}
      {showModelSelection && (
        <ModelSelection providerId={activeProvider} onSelect={async (modelId) => {
          setShowModelSelection(false);
          setActiveModel(`${activeProvider}/${modelId}`);
          await reloadAgent();
        }} onCancel={() => setShowModelSelection(false)} />
      )}
      {showMcpConfig && <McpConfig onDone={() => setShowMcpConfig(false)} />}
      {showThemeSelection && (
        <ThemeSelection currentTheme={loadTheme().id} onSelect={async (themeId) => {
          switchTheme(themeId);
          setShowThemeSelection(false);
          const currentConfig = loadXdgConfig();
          saveXdgConfig({ ...currentConfig, uiTheme: themeId as "light" | "dark" | "system" });
          await reloadAgent();
        }} onCancel={() => setShowThemeSelection(false)} />
      )}
    </Box>
  );
}
