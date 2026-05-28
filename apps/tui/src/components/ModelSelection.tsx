import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";

export interface ModelSelectionProps {
  providerId: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

export default function ModelSelection({ providerId, onSelect, onCancel }: ModelSelectionProps) {
  const config = loadXdgConfig();
  const availableModels = config.models[providerId] || [];
  
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
        if (customModel.trim()) {
          const currentConfig = loadXdgConfig();
          saveXdgConfig({
            ...currentConfig,
            activeModel: customModel.trim(),
            // Optionally add to available models if not there
            models: {
              ...currentConfig.models,
              [providerId]: Array.from(new Set([...(currentConfig.models[providerId] || []), customModel.trim()]))
            }
          });
          onSelect(customModel.trim());
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
      
      const currentConfig = loadXdgConfig();
      saveXdgConfig({
        ...currentConfig,
        activeModel: selection,
      });
      onSelect(selection);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderColor="cyan" paddingX={1} paddingY={1} width="60%">
      <Text bold color="cyan">Select Model for {providerId}</Text>
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
                <Text color={i === selectedIndex ? "cyan" : "gray"}>
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
