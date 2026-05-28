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
  ollama: "gemini-3-flash-preview:cloud",
  mlx: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
};

const providers: Provider[] = [
  { id: "ollama", name: "Ollama Cloud", description: "Ollama cloud-hosted models", needsApiKey: true, apiKeyOptional: true, apiKeyHint: "API key (Enter to skip → local Ollama)" },
  { id: "openai", name: "OpenAI", description: "GPT-4 and other models", needsApiKey: true, apiKeyHint: "API key" },
  { id: "anthropic", name: "Anthropic", description: "Claude models", needsApiKey: true, apiKeyHint: "API key" },
  { id: "mlx", name: "MLX (Local)", description: "Local Apple Silicon GPU models", needsApiKey: false },
];

export default function ProviderSelection({ onSelect, onCancel, accent = "cyan" }: ProviderSelectionProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showingApiKeyInput, setShowingApiKeyInput] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const selectedProvider = providers[selectedIndex];

  const commitSelection = (apiKey?: string) => {
    const currentConfig = loadXdgConfig();
    const providerId = selectedProvider.id;
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
          <Text color="green">{apiKeyInput}<Text color="gray">_</Text></Text>
          <Text dimColor>
            {selectedProvider.apiKeyOptional
              ? "Enter key or press Return to skip (uses local endpoint)"
              : "Enter API key, Return to confirm, Esc to go back"}
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
