import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { loadXdgConfig, saveXdgConfig, normalizeModelName } from "@metalmind/config";
import { discoverModels } from "../model-discovery.js";

export interface ModelSelectionProps {
  providerId: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  accent?: string;
}

export default function ModelSelection({ providerId, onSelect, onCancel, accent = "cyan" }: ModelSelectionProps) {
  const config = loadXdgConfig();
  const [availableModels, setAvailableModels] = useState<string[]>(config.models[providerId] || []);
  const [discovering, setDiscovering] = useState(true);

  // Auto-discover live models from the provider's API/daemon, merged with the
  // static list — degrades silently to the static list on failure (#214).
  useEffect(() => {
    let cancelled = false;
    discoverModels(providerId)
      .then((models) => { if (!cancelled && models.length) setAvailableModels(models); })
      .finally(() => { if (!cancelled) setDiscovering(false); });
    return () => { cancelled = true; };
  }, [providerId]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isCustom, setIsCustom] = useState(false);
  const [customModel, setCustomModel] = useState("");

  const allOptions = [...availableModels, "Custom..."];

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (isCustom) {
      if (key.return) {
        const raw = customModel.trim();
        if (raw) {
          const model = normalizeModelName(providerId, raw);
          const currentConfig = loadXdgConfig();
          saveXdgConfig({
            ...currentConfig,
            activeModel: model,
            models: {
              ...currentConfig.models,
              [providerId]: Array.from(new Set([...(currentConfig.models[providerId] || []), model])),
            },
          });
          onSelect(model);
        }
        return;
      }
      if (key.backspace) {
        setCustomModel(prev => prev.slice(0, -1));
        return;
      }
      if (input) {
        setCustomModel(prev => prev + input);
      }
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, allOptions.length - 1));
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (key.return) {
      const selection = allOptions[selectedIndex];
      if (selection === "Custom...") {
        setIsCustom(true);
        return;
      }
      const model = normalizeModelName(providerId, selection);
      const currentConfig = loadXdgConfig();
      saveXdgConfig({ ...currentConfig, activeModel: model });
      onSelect(model);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderColor={accent} paddingX={1} paddingY={1} width="60%">
      <Text bold color={accent}>Select Model for {providerId}{discovering ? " (discovering…)" : ""}</Text>
      {isCustom ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color="yellow">Enter custom model name:</Text>
          <Text color="green">{customModel}_</Text>
          <Text dimColor>
            (Esc to cancel, Return to confirm)
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingY={1}>
          {allOptions.map((model, i) => (
            <Box key={model} flexDirection="row" marginRight={1}>
              <Box width={3}>
                <Text color={i === selectedIndex ? accent : "gray"}>
                  {i === selectedIndex ? ">" : " "}
                </Text>
              </Box>
              <Text color={model === "Custom..." ? "yellow" : "white"}>{model}</Text>
            </Box>
          ))}
          <Text dimColor>
            Arrow keys to navigate, Return to select, Esc to cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}
