import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { discoverMlxModels, discoverOllamaModels } from "../local-model-discovery.js";

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

// Tiers 1 and 2 are DISCOVERED from the machine (see useTierOptions): a static
// list could not offer a model you had just downloaded, and offered several you
// had never installed. Tier 3 is a remote catalogue, so it stays declared.
const CLOUD_OPTIONS: ModelOption[] = [
  { label: "glm-5.2:cloud            (reasoning, default)", provider: "ollama-cloud", model: "glm-5.2:cloud" },
  { label: "gemini-3-flash-preview   (fast)", provider: "ollama-cloud", model: "gemini-3-flash-preview:latest" },
  { label: "gemma4:31b-cloud         (31B, quality)", provider: "ollama-cloud", model: "gemma4:31b-cloud" },
  { label: "devstral-small-2:24b     (coding, 24B)", provider: "ollama-cloud", model: "devstral-small-2:24b-cloud" },
  { label: "devstral-2:123b          (coding, 123B)", provider: "ollama-cloud", model: "devstral-2:123b-cloud" },
];

/** Options for a tier: what is installed for the local tiers, the catalogue for
 *  the cloud one. The currently configured model is always included, even when
 *  discovery cannot see it, so the picker never hides the active choice. */
function useTierOptions(tier: 1 | 2 | 3, currentModel?: string): ModelOption[] {
  const [discovered, setDiscovered] = useState<ModelOption[] | null>(
    tier === 3 ? CLOUD_OPTIONS : null,
  );

  useEffect(() => {
    if (tier === 3) return;
    let cancelled = false;

    if (tier === 1) {
      const opts = discoverMlxModels().map((m) => ({ label: m.label, provider: "mlx", model: m.model }));
      setDiscovered(opts);
      return;
    }

    discoverOllamaModels().then((models) => {
      if (cancelled) return;
      setDiscovered(models.map((m) => ({ label: m.label, provider: "ollama", model: m.model })));
    });
    return () => {
      cancelled = true;
    };
  }, [tier]);

  const options = discovered ?? [];
  if (currentModel && !options.some((o) => o.model === currentModel)) {
    return [
      { label: `${currentModel}  (current)`, provider: TIER_PROVIDERS[tier], model: currentModel },
      ...options,
    ];
  }
  return options;
}

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
  const options = useTierOptions(tier, currentModel);
  const allOptions = [...options, { label: "Custom...", provider: TIER_PROVIDERS[tier], model: "" }];

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Discovery for tier 2 resolves after the first render, so start the cursor
  // on the model already in use once the list arrives.
  useEffect(() => {
    const idx = options.findIndex((o) => o.model === currentModel);
    if (idx >= 0) setSelectedIndex(idx);
  }, [options.length, currentModel]);
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
          {options.length === 0 && (
            <Text dimColor>
              {tier === 1
                ? "No MLX models found in ~/.lmstudio/models or the HuggingFace cache."
                : "No local Ollama models found (is the daemon running?)."}
            </Text>
          )}
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
