import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface TierModelPickerProps {
  tier: 1 | 2 | 3;
  currentModel?: string;
  onSelect: (provider: string, model: string) => void;
  onCancel: () => void;
  accent?: string;
}

interface ModelOption {
  label: string;
  provider: string;
  model: string;
}

// Known model lists per tier.  Tier 3 lists are the Ollama cloud catalogue.
const TIER_OPTIONS: Record<1 | 2 | 3, ModelOption[]> = {
  1: [
    { label: "gemma-3-12b-it-qat-4bit  (MLX, LM Studio)", provider: "mlx", model: "/Users/janipasanen/.lmstudio/models/mlx-community/gemma-3-12b-it-qat-4bit" },
    { label: "DeepSeek-Coder-1.3B-4bit (MLX, HuggingFace)", provider: "mlx", model: "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit" },
  ],
  2: [
    { label: "gemma4:e2b-mlx           (2B, Apple Silicon)", provider: "ollama", model: "gemma4:e2b-mlx" },
    { label: "gemma3:4b                (4B, general)", provider: "ollama", model: "gemma3:4b" },
    { label: "deepseek-coder:1.3b      (1.3B, coding)", provider: "ollama", model: "deepseek-coder:1.3b" },
  ],
  3: [
    { label: "gemini-3-flash-preview   (fast, default)", provider: "ollama-cloud", model: "gemini-3-flash-preview:latest" },
    { label: "gemma4:31b-cloud         (31B, quality)", provider: "ollama-cloud", model: "gemma4:31b-cloud" },
    { label: "glm-5.1:cloud            (reasoning)", provider: "ollama-cloud", model: "glm-5.1:cloud" },
    { label: "devstral-small-2:24b     (coding, 24B)", provider: "ollama-cloud", model: "devstral-small-2:24b-cloud" },
    { label: "devstral-2:123b          (coding, 123B)", provider: "ollama-cloud", model: "devstral-2:123b-cloud" },
  ],
};

const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Tier 1 — MLX GPU",
  2: "Tier 2 — Local Ollama",
  3: "Tier 3 — Ollama Cloud",
};

const TIER_PROVIDERS: Record<1 | 2 | 3, string> = {
  1: "mlx",
  2: "ollama",
  3: "ollama-cloud",
};

export default function TierModelPicker({ tier, currentModel, onSelect, onCancel, accent = "cyan" }: TierModelPickerProps) {
  const options = TIER_OPTIONS[tier];
  const allOptions = [...options, { label: "Custom...", provider: TIER_PROVIDERS[tier], model: "" }];

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex(o => o.model === currentModel);
    return idx >= 0 ? idx : 0;
  });
  const [isCustom, setIsCustom] = useState(false);
  const [customModel, setCustomModel] = useState("");

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }

    if (isCustom) {
      if (key.return) {
        const raw = customModel.trim();
        if (raw) onSelect(TIER_PROVIDERS[tier], raw);
        return;
      }
      if (key.backspace || key.delete) { setCustomModel(prev => prev.slice(0, -1)); return; }
      if (input) { setCustomModel(prev => prev + input); }
      return;
    }

    if (key.downArrow) { setSelectedIndex(prev => Math.min(prev + 1, allOptions.length - 1)); return; }
    if (key.upArrow)   { setSelectedIndex(prev => Math.max(prev - 1, 0)); return; }

    if (key.return) {
      const sel = allOptions[selectedIndex];
      if (sel.model === "") { setIsCustom(true); return; }
      onSelect(sel.provider, sel.model);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} paddingY={1} width="70%">
      <Text bold color={accent}>Select model for {TIER_LABELS[tier]}</Text>

      {isCustom ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color="yellow">Enter model name:</Text>
          <Text color="green">{customModel}_</Text>
          <Text dimColor>Return to confirm · Esc to cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingY={1}>
          {allOptions.map((opt, i) => {
            const isCurrent = opt.model === currentModel;
            const isSelected = i === selectedIndex;
            return (
              <Box key={opt.model || "custom"} flexDirection="row">
                <Box width={3}>
                  <Text color={isSelected ? accent : "gray"}>{isSelected ? ">" : " "}</Text>
                </Box>
                <Text color={opt.model === "" ? "yellow" : "white"}>
                  {opt.label}
                </Text>
                {isCurrent && <Text color="green"> ✓</Text>}
              </Box>
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>↑↓ navigate · Return select · Esc cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
