import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";

export interface Provider {
  id: string;
  name: string;
  description: string;
  needsApiKey: boolean;
  apiKeyOptional?: boolean;
  apiKeyHint?: string;
}

export interface ProviderSelectionProps {
  onSelect: (providerId: string) => void;
  onCancel: () => void;
  accent?: string;
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  "ollama-cloud": "gpt-oss:120b",
  ollama: "ministral-3:3b",
  mlx: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
};

// The cloud entry must save the "ollama-cloud" provider id (#370). It used to
// save "ollama" — the LOCAL provider — together with a cloud-only model, so
// entering a valid API key produced a config pointing at 127.0.0.1:11434 with a
// model that isn't installed there: every request failed with a confusing
// "model not found" right after a successful-looking setup.
const providers: Provider[] = [
  { id: "ollama-cloud", name: "Ollama Cloud", description: "Ollama cloud-hosted models (api.ollama.com)", needsApiKey: true, apiKeyOptional: true, apiKeyHint: "API key (Enter to skip → local Ollama)" },
  { id: "ollama", name: "Ollama (Local)", description: "Models running on this machine (localhost:11434)", needsApiKey: false },
  { id: "openai", name: "OpenAI", description: "GPT-4 and other models", needsApiKey: true, apiKeyHint: "API key" },
  { id: "anthropic", name: "Anthropic", description: "Claude models", needsApiKey: true, apiKeyHint: "API key" },
  { id: "mlx", name: "MLX (Local)", description: "Local Apple Silicon GPU models", needsApiKey: false },
];

export default function ProviderSelection({ onSelect, onCancel, accent = "cyan" }: ProviderSelectionProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showingApiKeyInput, setShowingApiKeyInput] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const selectedProvider = providers[selectedIndex];
  const savedKey = loadXdgConfig().apiKeys?.[selectedProvider?.id];
  const maskedSaved = savedKey ? `${savedKey.slice(0, 8)}${"*".repeat(Math.min(12, savedKey.length - 8))}` : null;

  const commitSelection = (apiKey?: string) => {
    const currentConfig = loadXdgConfig();
    // "Ollama Cloud" without a key can't reach the cloud — fall back to the
    // LOCAL provider (and a local default model) rather than saving a cloud
    // provider that will 401 on the first message (#370).
    const skippedCloudKey = selectedProvider.id === "ollama-cloud" && !apiKey && !currentConfig.apiKeys?.["ollama-cloud"] && !currentConfig.apiKeys?.["ollama"] && !process.env.OLLAMA_API_KEY;
    const providerId = skippedCloudKey ? "ollama" : selectedProvider.id;
    saveXdgConfig({
      ...currentConfig,
      activeProvider: providerId,
      activeModel: DEFAULT_MODELS[providerId] ?? currentConfig.activeModel,
      ...(apiKey ? { apiKeys: { ...currentConfig.apiKeys, [providerId]: apiKey } } : {}),
    });
    onSelect(providerId);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (showingApiKeyInput) {
        setShowingApiKeyInput(false);
        setApiKeyInput("");
        return;
      }
      onCancel();
      return;
    }

    if (showingApiKeyInput) {
      if (key.return) {
        commitSelection(apiKeyInput || undefined);
        return;
      }
      if (key.backspace) {
        setApiKeyInput((prev) => prev.slice(0, -1));
        return;
      }
      if (input) {
        setApiKeyInput((prev) => prev + input);
      }
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, providers.length - 1));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (key.return) {
      if (selectedProvider.needsApiKey) {
        setShowingApiKeyInput(true);
      } else {
        commitSelection();
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" borderColor={accent} paddingX={1} paddingY={1} width="60%">
      <Text bold color={accent}>Select Remote/Cloud Provider</Text>
      <Text dimColor>Used for complex tasks — local M1/GPU handles simple ones</Text>
      {showingApiKeyInput ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color="yellow">
            {selectedProvider.name} — {selectedProvider.apiKeyHint ?? "API key"}:
          </Text>
          {maskedSaved && !apiKeyInput && (
            <Text dimColor>Current: {maskedSaved}</Text>
          )}
          <Text color="green">{"*".repeat(apiKeyInput.length)}<Text color="gray">_</Text></Text>
          <Text dimColor>
            {selectedProvider.apiKeyOptional
              ? "Type new key + Return, or Return to keep current / use local endpoint"
              : "Type new key + Return to confirm, Esc to go back"}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingY={1}>
          {providers.map((provider, i) => (
            <Box key={provider.id} flexDirection="row" marginRight={1}>
              <Box width={3}>
                <Text color={i === selectedIndex ? accent : "gray"}>
                  {i === selectedIndex ? ">" : " "}
                </Text>
              </Box>
              <Text>{provider.name}</Text>
              <Box flexGrow={1} />
              <Text dimColor>{provider.description}</Text>
            </Box>
          ))}
          <Text dimColor>Arrow keys to navigate, Return to select, Esc to cancel</Text>
        </Box>
      )}
    </Box>
  );
}
