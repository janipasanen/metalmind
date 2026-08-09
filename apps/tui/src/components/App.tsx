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
import { handleMcpCommand, formatMcpStatus } from "../mcp-command.js";
import { listModelsText, deleteModelText, pullModelProgress } from "../model-command.js";
import { handlePromptCommand } from "../prompt-command.js";
import { buildImageUrl } from "../image-command.js";
import { handleRagCommand } from "../rag/manager.js";
import { handleAllowCommand } from "../approval-allowlist.js";
import { diagnosticsReport } from "../error-log.js";
import { handleCopyCommand } from "../copy-command.js";
import { sanitizeForDisplay, sanitizeAndTruncate } from "../sanitize.js";
import { formatMention } from "../mentions.js";
import { VIM_HELP } from "../vim.js";
import { loadUserCommands, expandUserCommand } from "../user-commands.js";
import type { TuiConfig } from "../config.js";
import { Coordinator, SafetyValidator } from "@metalmind/core";
import type { CoordinatorPhase, PlanStep } from "@metalmind/core";
import type { ModelRoutingDecision } from "@metalmind/schemas";
import CommandPalette from "./CommandPalette.js";
import ProviderSelection from "./ProviderSelection.js";
import ModelSelection from "./ModelSelection.js";
import McpConfig from "./McpConfig.js";
import ThemeSelection from "./ThemeSelection.js";
import TierModelPicker from "./TierModelPicker.js";
import FileTree from "./FileTree.js";
import Notifications, { type Notification, type NotificationType } from "./Notifications.js";
import { loadXdgConfig, saveXdgConfig, switchTheme, loadTheme } from "@metalmind/config";
import { KeychainConfig } from "@metalmind/apple";
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
    diff?: string;
    filePath?: string;
  }>;
  timestamp: Date;
}

interface AppProps {
  config: TuiConfig;
}

/** Messages shown per screen in the scrollback pager (#159). */
/** Rows the surrounding chrome needs (header, status bar, input box, margins).
 *  The transcript gets whatever is left (#430). */
const CHROME_ROWS = 14;
const MIN_PAGE_SIZE = 3;
const DEFAULT_PAGE_SIZE = 12;

/** Messages that fit on screen, derived from the ACTUAL terminal height and kept
 *  in sync on resize (#430). A fixed 12 overflowed short terminals, which makes
 *  Ink clear and repaint the ENTIRE screen on every streamed token — the visible
 *  flicker, and a wall of noise for a screen reader. */
function useChatPageSize(): number {
  const measure = () =>
    Math.max(MIN_PAGE_SIZE, (process.stdout.rows ?? DEFAULT_PAGE_SIZE + CHROME_ROWS) - CHROME_ROWS);
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const onResize = () => setSize(measure());
    process.stdout.on?.("resize", onResize);
    return () => {
      process.stdout.off?.("resize", onResize);
    };
  }, []);
  return size;
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
  const [scrollOffset, setScrollOffset] = useState(0);
  const [vimMode, setVimMode] = useState(() => loadXdgConfig().vimMode ?? false);
  const [projectName] = useState(() => {
    const parts = process.cwd().split("/");
    return parts[parts.length - 1] || "metalmind";
  });
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showProviderSelection, setShowProviderSelection] = useState(false);
  const [showModelSelection, setShowModelSelection] = useState(false);
  const [showMcpConfig, setShowMcpConfig] = useState(false);
  const [showThemeSelection, setShowThemeSelection] = useState(false);
  const [showFileTree, setShowFileTree] = useState(false);
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
  const [approvalScroll, setApprovalScroll] = useState(0);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number } | undefined>(undefined);
  const [agentMode, setAgentMode] = useState<"build" | "plan">("build");
  const [todos, setTodos] = useState<Array<{ text: string; status: "pending" | "in_progress" | "completed" }>>([]);
  const [pendingInsert, setPendingInsert] = useState<{ text: string; nonce: number } | null>(null);
  /** Seconds spent in the current reasoning burst (#344). */
  const reasoningStartRef = useRef<number | null>(null);
  const [reasoningSecs, setReasoningSecs] = useState(0);
  /** Live tail of the currently-running tool's output (already redacted). */
  const [liveTool, setLiveTool] = useState<{ name: string; tail: string } | null>(null);
  // Staged vision attachments (#375): without a persistent indicator an image
  // staged before /clear was invisible but still attached to the next message.
  const [stagedImages, setStagedImages] = useState(0);
  const chatPageSize = useChatPageSize();
  // Mirrored so the status bar shows the live routing mode (#routing).
  const [evaluateEachPrompt, setEvaluateEachPrompt] = useState(true);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [localWorkerModel, _setLocalWorkerModel] = useState<string | undefined>(undefined);
  const [localWorkerProvider, _setLocalWorkerProvider] = useState<string | undefined>(undefined);
  const [localWorkerAvailable, setLocalWorkerAvailable] = useState(false);
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; connected: boolean; toolCount: number }>>([]);
  const [statusCollapsed, setStatusCollapsed] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const notifIdRef = useRef(0);
  const notifHistoryRef = useRef<Array<{ type: NotificationType; message: string }>>([]);

  // Push a transient notification (legacy #8): shown briefly, auto-dismissed, and
  // appended to a bounded history viewable via /notifications.
  const notify = useCallback((type: NotificationType, message: string) => {
    const id = ++notifIdRef.current;
    notifHistoryRef.current = [...notifHistoryRef.current, { type, message }].slice(-50);
    setNotifications((prev) => [...prev.slice(-3), { id, type, message }]);
    setTimeout(() => setNotifications((prev) => prev.filter((n) => n.id !== id)), 6000);
  }, []);

  // Mirror the agent's MCP server status into the StatusBar footer (#267).
  const syncMcpStatus = useCallback((agent: AgentLoop) => {
    setMcpServers(agent.getMcpStatus().map((s) => ({ name: s.id, connected: s.connected, toolCount: s.toolCount })));
  }, []);

  // Monotonic reload sequence: a second reload started before the first
  // finishes must WIN (its config is newer) and the loser must dispose its own
  // half-built agent instead of leaking it or clobbering the newer one.
  const reloadSeq = useRef(0);
  /** Set when a reload had to be abandoned mid-turn; retried on idle (#440). */
  const pendingReloadRef = useRef(false);
  // Mirror of useChat's isStreaming (declared later) for use in callbacks
  // defined before it.
  const isStreamingRef = useRef(false);

  const reloadAgent = useCallback(async () => {
    let cancelled = false;
    // Reloading disposes the active agent — doing that during a live turn kills
    // the in-flight stream and its sqlite handle from under it.
    if (isStreamingRef.current) {
      notify("warning", "Model switch deferred — finish or Esc the current turn first, then retry.");
      return () => {};
    }
    const mySeq = ++reloadSeq.current;

    (async () => {
      try {
        const currentConfig = resolveConfig();
        const router = currentConfig.explicit ? undefined : await createDefaultRouter(currentConfig);
        if (cancelled) return;
        const previous = agentRef.current;
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
          onTodos: (t) => setTodos(t),
          onToolProgress: (name, chunk) =>
            setLiveTool((prev) => ({ name, tail: ((prev?.name === name ? prev.tail : "") + chunk).slice(-600) })),
          onPersistenceIssue: (msg) => notify("warning", msg),
        });
        await agent.initMcp();
        await agent.initCoordinator();
        if (cancelled || mySeq !== reloadSeq.current) {
          // A newer reload superseded this one — release everything we built.
          agent.dispose();
          return;
        }
        // A turn may have STARTED while we were building (initMcp/initCoordinator
        // take seconds); disposing the previous agent now would close its sqlite
        // store and MCP clients mid-run (#369). Abandon this reload instead —
        // the user is told to retry, exactly like the entry check.
        if (isStreamingRef.current) {
          agent.dispose();
          // Queue the retry instead of just telling the user (#440): /apikey and
          // /model already reported success and PERSISTED the new config, so
          // silently abandoning the rebuild left the app running the old
          // provider while the UI and config both said otherwise.
          pendingReloadRef.current = true;
          notify("warning", "Model switch deferred — a turn was in flight. It will apply automatically when this turn finishes.");
          return;
        }
        // Carry the conversation and session-scoped settings over to the new
        // agent, and keep writing to the SAME persisted session (#368).
        const resumeId = previous ? agent.adoptStateFrom(previous) : undefined;
        agentRef.current = agent;
        setEvaluateEachPrompt(agent.getEvaluateEachPrompt()); // persisted across restarts
        // Dispose the replaced agent so its sqlite handle, MCP clients, and
        // background processes are released instead of leaking on each reload (#242).
        previous?.dispose();
        await agent.initPersistence(resumeId ? { resumeId } : {});
        syncMcpStatus(agent);
        setAgentError(null);

        const coordinator = agent.coordinatorInstance;
        if (coordinator) {
          const wp = coordinator.getRunner();
          const name = wp.providerName; // public accessor (#230)
          if (name) {
            _setLocalWorkerProvider(name);
            setLocalWorkerAvailable(true);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setAgentError(msg);
          notify("error", `Reload failed: ${msg}`);
        }
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
          onTodos: (t) => setTodos(t),
          onToolProgress: (name, chunk) =>
            setLiveTool((prev) => ({ name, tail: ((prev?.name === name ? prev.tail : "") + chunk).slice(-600) })),
          onPersistenceIssue: (msg) => notify("warning", msg),
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
        if (!cancelled) syncMcpStatus(agent);

        // Non-blocking pre-flight: warn up front on a bad key/missing model (#174).
        void agent.checkHealth().then((h) => {
          if (!cancelled) {
            // Only the persistent line — notifying as well printed the SAME
            // warning twice on startup. The line stays until the problem is
            // fixed (it is re-checked after every turn), so a toast adds
            // nothing but noise.
            setHealthWarning(h.ok ? null : h.message);
          }
        });

        const coordinator = agent.coordinatorInstance;
        if (coordinator) {
          const wp = coordinator.getRunner();
          const name = wp.providerName; // public accessor (#230)
          if (name) {
            _setLocalWorkerProvider(name);
            setLocalWorkerAvailable(true);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setAgentError(msg);
          notify("error", msg);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config]);

  const { messages, sendMessage, isStreaming, streamingContent, streamingReasoning, activeToolCalls, cancelStream, replaceMessages } = useChat({
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
          "  /trust [allow|revoke] - Review/grant this project's startup hooks & MCP servers",
          "  /routing [on|off] - Evaluate each prompt for a tier, or always use cloud",
          "  /skill            - list | activate <name> | deactivate <name>",
          "  /resume [id]      - List/resume sessions; search <text> | rename <id> <title> | tag <id> <tags>",
          "  /compact          - Summarize older turns to reclaim context window",
          "  /export [md|json] - Export the conversation transcript to a file",
          "  /cost             - Show this session's token usage",
          "  /budget [set <usd>|off] - View or set the session spend cap",
          "  /routes           - Show routing decisions + per-tier hit counts",
          "  /brain [on|off]   - Remote-brain mode: cloud coordinates, delegates to local",
          "  /plan | /build    - Plan mode (read-only, proposes a plan) vs Build mode (executes)",
          "  /tree | /files    - Browse the project files (↑↓ move, →/Enter expand, Esc close)",
          "  /commit [context] - Stage everything + AI-generated Conventional Commit (approval-gated)",
          "  /pr [context]     - Push the branch + create a GitHub PR via gh (approval-gated)",
          "  /test|/check|/lint [cmd] - Run tests / project check / lint; results feed the model",
          "  /checkpoints | /rollback [turn] - List / restore turn-level git worktree checkpoints",
          "  /notifications    - Show recent notifications (errors, warnings, MCP status)",
          "  /doctor           - Check ollama/cloud key/gh/rg/LSP/persistence with fixes",
          "  /<custom>         - Your own commands: .metalmind/commands/<name>.md ($ARGUMENTS)",
          "  /keychain         - save | load | status — macOS keychain key storage",
          "  /retry            - Re-run the last prompt (drops the prior answer)",
          "  /edit <text>      - Replace + re-run the last prompt",
          "  /branch           - Fork this conversation into a new session",
          "  /copy [last|code|all|<n>] - Copy the last message, its code block, the whole chat, or the nth-last reply",
          "  /search <text>    - Find text in this conversation's transcript",
          "  /vim [on|off|help]- Toggle vim modal editing in the input bar",
          "  /undo             - Revert the agent's last edit set (repeatable)",
          "  /redo             - Re-apply the most recently undone edit set",
          "  /audit            - Show this session's tool-call log",
          "  /diagnostics      - Show recent errors / crash log (persisted across sessions)",
          "  /mcp              - MCP: list|presets|add|remove|status|reconnect | resources|prompts|read|auth <srv>",
          "  /models           - Local Ollama models: list | pull <name> | delete <name>",
          "  /image            - Attach an image (path or https URL) for a vision model",
          "  /rag              - Retrieval: add <path> | search <q> | status | clear (queries auto-retrieve)",
          "  /remember <text>  - Save a durable fact to long-term memory (loads next session)",
          "  /allow            - Persist auto-approval: tool <name> | path <glob> | command <prefix> | list | clear",
          "  /prompt           - Prompt library: save <name> <tmpl> | list | delete | <name> k=v",
          "  /clear            - Clear chat history",
          "  /quit             - Exit",
          "",
          "Ctrl+P            - Open command palette (tier, provider, model, theme, MCP)",
        ].join("\n") } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/quit") {
        // A real shutdown: take the background processes with us (#409). The
        // reload paths below deliberately do NOT, so a superseded model switch
        // can't kill the live agent's dev server.
        agentRef.current?.dispose({ killBackgroundProcesses: true });
        yield { type: "done" } as const;
        process.exit(0);
      }

      if (input === "/clear") {
        // Start a new persisted session rather than destroying history (#140), and
        // clear the on-screen transcript so the UI matches the session (#263).
        agentRef.current?.newSession();
        replaceMessages([]);
        setScrollOffset(0);
        setStagedImages(0); // /clear drops staged attachments too (#375)
        yield { type: "text", text: "Cleared." } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/resume" || input.startsWith("/resume ")) {
        const arg = input.slice(7).trim();
        const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
        const agent = agentRef.current;
        const fmt = (s: { id: string; updated_at: string; title?: string; tags?: string }) =>
          `  ${s.id}  (updated ${s.updated_at})${s.title ? ` — ${s.title}` : ""}${s.tags ? `  [${s.tags}]` : ""}`;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else if (sub === "search") {
          const q = rest.join(" ");
          if (!q) {
            yield { type: "text", text: "Usage: /resume search <text>" } as const;
          } else {
            const found = agent.searchSessions(q);
            yield {
              type: "text",
              text: found.length
                ? `Sessions matching "${q}":\n${found.slice(0, 15).map(fmt).join("\n")}`
                : `No sessions matching "${q}".`,
            } as const;
          }
        } else if (sub === "rename") {
          const id = rest[0];
          const title = rest.slice(1).join(" ");
          yield {
            type: "text",
            text: !id || !title ? "Usage: /resume rename <id> <title>" : agent.renameSession(id, title) ? `Renamed ${id} → "${title}".` : `Couldn't rename ${id}.`,
          } as const;
        } else if (sub === "tag") {
          const id = rest[0];
          const tags = rest.slice(1).join(" ");
          yield {
            type: "text",
            text: !id ? "Usage: /resume tag <id> <tag1,tag2>" : agent.tagSession(id, tags) ? `Tagged ${id}: ${tags || "(cleared)"}` : `Couldn't tag ${id}.`,
          } as const;
        } else if (!sub) {
          const sessions = agent.listSessions();
          yield {
            type: "text",
            text: sessions.length
              ? `Recent sessions — resume with /resume <id>:\n${sessions.slice(0, 15).map(fmt).join("\n")}`
              : "No saved sessions yet.",
          } as const;
        } else if (!agent.listSessions().some((s) => s.id === sub)) {
          // An unknown id (or a typo'd subcommand like "list") must NOT wipe the
          // current conversation — resumeSession would load an empty history.
          yield {
            type: "text",
            text: `No session "${sub}" found. /resume lists sessions; subcommands: search <text> | rename <id> <title> | tag <id> <tags>`,
          } as const;
        } else {
          const restored = agent.resumeSession(sub);
          replaceMessages(restoredToChatMessages(restored));
          setStagedImages(0); // resuming drops staged attachments (#375)
          yield { type: "text", text: `Resumed session ${sub} (${restored.length} messages).` } as const;
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

      if (input === "/routing" || input.startsWith("/routing ")) {
        const agent = agentRef.current;
        const sub = input.slice(9).trim().toLowerCase();
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else if (sub === "on" || sub === "auto") {
          const msg = agent.setEvaluateEachPrompt(true);
          setEvaluateEachPrompt(true);
          yield { type: "text", text: msg } as const;
        } else if (sub === "off" || sub === "cloud") {
          const msg = agent.setEvaluateEachPrompt(false);
          setEvaluateEachPrompt(false);
          yield { type: "text", text: msg } as const;
        } else {
          const on = agent.getEvaluateEachPrompt();
          yield {
            type: "text",
            text: [
              `Per-prompt routing: ${on ? "ON" : "OFF"}`,
              "",
              on
                ? "Each prompt is evaluated and simple work runs on tier 1/2 (local) when that is enough; complex work escalates to tier 3 (cloud)."
                : "Every prompt goes straight to tier 3 (cloud) — no evaluation.",
              "",
              "/routing on   — evaluate each prompt (default)",
              "/routing off  — always use tier 3",
              "/tier 1|2|3   — pin one tier for this session regardless of this setting",
            ].join("\n"),
          } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/trust" || input.startsWith("/trust ")) {
        const agent = agentRef.current;
        const sub = input.slice(6).trim().toLowerCase();
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else if (sub === "revoke") {
          yield { type: "text", text: agent.revokeThisWorkspace() } as const;
        } else if (sub === "allow" || sub === "yes") {
          yield { type: "text", text: agent.trustThisWorkspace() } as const;
        } else {
          const { trusted, declared } = agent.trustStatus();
          const lines = [
            `Workspace trust: ${trusted ? "TRUSTED" : "NOT trusted"}`,
            "",
            "An untrusted project's own .metalmind/hooks.json (commands run at startup),",
            "metalmind.yaml `mcp` servers (spawned at startup) and `permissions` grants",
            "(which pre-approve mutating tools) are IGNORED — so cloning a repo and opening",
            "it here cannot execute that repo's code.",
          ];
          if (declared.length > 0) {
            lines.push("", "This project declares:", ...declared.map((d) => `  • ${d}`));
          } else {
            lines.push("", "This project declares no startup hooks.");
          }
          lines.push("", trusted ? "/trust revoke — disable them again" : "/trust allow — enable them (review the list above first)");
          yield { type: "text", text: lines.join("\n") } as const;
        }
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
        // Spend is meaningful now that the cloud tier is actually priced (#360).
        const b = agentRef.current?.getBudgetStatus();
        const spendLine = b
          ? `\n  spend:  $${b.spentUsd.toFixed(4)}${b.budgetUsd !== undefined ? ` of $${b.budgetUsd.toFixed(2)} cap${b.overBudget ? " — CAP REACHED, cloud routing downgraded to local" : ""}` : " (no cap set — /budget set <usd>)"}`
          : "";
        const text = u
          ? `Session token usage:\n  input:  ${u.inputTokens.toLocaleString()}\n  output: ${u.outputTokens.toLocaleString()}\n  total:  ${(u.inputTokens + u.outputTokens).toLocaleString()}${spendLine}`
          : "Agent not initialised.";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/keychain" || input.startsWith("/keychain ")) {
        const sub = input.slice(9).trim() || "status";
        const kc = new KeychainConfig();
        const cfg = loadXdgConfig();
        try {
          if (sub === "save") {
            const saved: string[] = [];
            for (const [provider, key] of Object.entries(cfg.apiKeys)) {
              if (key && (await kc.setKey(provider, key))) saved.push(provider);
            }
            yield { type: "text", text: saved.length ? `Saved to macOS keychain: ${saved.join(", ")}` : "No keys saved (keychain unavailable or no keys set)." } as const;
          } else if (sub === "load") {
            const merged = { ...cfg.apiKeys };
            const loaded: string[] = [];
            for (const provider of await kc.listProviders()) {
              const key = await kc.getKey(provider);
              if (key) { merged[provider] = key; loaded.push(provider); }
            }
            if (loaded.length) saveXdgConfig({ ...cfg, apiKeys: merged });
            yield { type: "text", text: loaded.length ? `Loaded from keychain: ${loaded.join(", ")}` : "Nothing to load from keychain." } as const;
          } else {
            const providers = await kc.listProviders();
            yield { type: "text", text: providers.length ? `Keys in keychain: ${providers.join(", ")}` : "No keys in keychain (or keychain unavailable). Use /keychain save." } as const;
          }
        } catch (err) {
          yield { type: "text", text: `Keychain error: ${err instanceof Error ? err.message : String(err)}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/budget" || input.startsWith("/budget ")) {
        const arg = input.slice(7).trim();
        const agent = agentRef.current;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else if (arg.startsWith("set ")) {
          const usd = parseFloat(arg.slice(4));
          if (Number.isFinite(usd) && usd > 0) {
            agent.setBudget(usd);
            yield { type: "text", text: `Session spend budget set to $${usd.toFixed(2)}. Cloud routing downgrades to local once reached.` } as const;
          } else {
            yield { type: "text", text: "Usage: /budget set <usd>  (e.g. /budget set 1.50)" } as const;
          }
        } else if (arg === "off" || arg === "clear") {
          agent.setBudget(undefined);
          yield { type: "text", text: "Spend budget cleared." } as const;
        } else {
          const s = agent.getBudgetStatus();
          if (!s) {
            yield { type: "text", text: "Budget tracking unavailable (no router configured)." } as const;
          } else if (s.budgetUsd === undefined) {
            yield { type: "text", text: `Spent this session: $${s.spentUsd.toFixed(4)} (no budget set — /budget set <usd>)` } as const;
          } else {
            yield { type: "text", text: `Spent: $${s.spentUsd.toFixed(4)} / $${s.budgetUsd.toFixed(2)}${s.overBudget ? " — OVER BUDGET: cloud routing is downgraded to local" : ""}` } as const;
          }
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/brain" || input.startsWith("/brain ")) {
        const arg = input.slice(6).trim();
        const agent = agentRef.current;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else if (arg === "on") {
          agent.setRemoteBrain(true);
          yield { type: "text", text: "Remote-brain mode ON — the cloud model coordinates and delegates bounded subtasks to the local model." } as const;
        } else if (arg === "off") {
          agent.setRemoteBrain(false);
          yield { type: "text", text: "Remote-brain mode OFF — normal tiered routing (local-first)." } as const;
        } else {
          yield { type: "text", text: `Remote-brain mode is ${agent.isRemoteBrain() ? "ON" : "OFF"}. Usage: /brain on|off` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/plan" || input === "/build" || input === "/mode" || input.startsWith("/mode ")) {
        const agent = agentRef.current;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else {
          const arg = input === "/plan" ? "plan" : input === "/build" ? "build" : input.slice(5).trim();
          if (arg === "plan" || arg === "build") {
            agent.setMode(arg);
            setAgentMode(arg);
            yield {
              type: "text",
              text:
                arg === "plan"
                  ? "Plan mode ON — I'll investigate and propose a step-by-step plan without changing files. Run /build to execute."
                  : "Build mode ON — I'll implement changes directly using all tools.",
            } as const;
          } else {
            yield { type: "text", text: `Current mode: ${agent.getMode()}. Usage: /plan | /build (or /mode plan|build)` } as const;
          }
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/routes") {
        const text = agentRef.current?.getRoutingSummary() ?? "Agent not initialised.";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/commit" || input.startsWith("/commit ")) {
        const agent = agentRef.current;
        if (!agent) { yield { type: "text", text: "Agent not initialised." } as const; }
        else {
          yield { type: "text", text: "Generating commit…" } as const;
          yield { type: "text", text: `\n${await agent.commitFlow(input.slice(7).trim(), signal)}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/pr" || input.startsWith("/pr ")) {
        const agent = agentRef.current;
        if (!agent) { yield { type: "text", text: "Agent not initialised." } as const; }
        else {
          yield { type: "text", text: "Preparing pull request…" } as const;
          yield { type: "text", text: `\n${await agent.prFlow(input.slice(3).trim(), signal)}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/doctor") {
        const agent = agentRef.current;
        if (!agent) { yield { type: "text", text: "Agent not initialised." } as const; }
        else {
          yield { type: "text", text: "Running checks…" } as const;
          yield { type: "text", text: `\n${await agent.doctorReport()}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/checkpoints") {
        yield { type: "text", text: agentRef.current?.listCheckpoints() ?? "Agent not initialised." } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/rollback" || input.startsWith("/rollback ")) {
        const arg = input.slice(9).trim();
        // A malformed arg ("/rollback turn 3") must be a usage error, NOT a
        // silent restore of the LATEST checkpoint over the current worktree.
        if (arg && !/^\d+$/.test(arg)) {
          yield { type: "text", text: `Unrecognized argument "${arg}". Usage: /rollback [turn-number] — see /checkpoints for the list.` } as const;
          yield { type: "done" } as const;
          return;
        }
        const text = agentRef.current?.rollbackToCheckpoint(arg ? Number(arg) : undefined) ?? "Agent not initialised.";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (/^\/(test|check|lint)( |$)/.test(input)) {
        const agent = agentRef.current;
        const kind = input.slice(1).split(" ")[0] as "test" | "check" | "lint";
        if (!agent) { yield { type: "text", text: "Agent not initialised." } as const; }
        else {
          yield { type: "text", text: `Running /${kind}…` } as const;
          yield { type: "text", text: `\n${await agent.verifyFlow(kind, input.slice(kind.length + 2).trim() || undefined, signal)}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/tree" || input === "/files") {
        setShowFileTree(true);
        yield { type: "done" } as const;
        return;
      }

      if (input === "/notifications" || input === "/notif") {
        const hist = notifHistoryRef.current;
        const text = hist.length === 0
          ? "No notifications yet."
          : ["Recent notifications:", ...hist.slice(-15).map((n) => `  [${n.type}] ${n.message}`)].join("\n");
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/mcp" || input.startsWith("/mcp ")) {
        const args = input.slice(4).trim();
        const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
        const agent = agentRef.current;
        // Live status / reconnect need the connected agent (#169).
        if (agent && sub === "status") {
          yield { type: "text", text: formatMcpStatus(agent.getMcpStatus()) } as const;
        } else if (agent && sub === "reconnect") {
          yield { type: "text", text: "Reconnecting MCP servers…" } as const;
          await agent.reconnectMcp();
          syncMcpStatus(agent);
          const st = agent.getMcpStatus();
          const up = st.filter((s) => s.connected).length;
          notify(up === st.length ? "success" : "warning", `MCP: ${up}/${st.length} server(s) connected`);
          yield { type: "text", text: formatMcpStatus(st) } as const;
        } else if (agent && (sub === "resources" || sub === "prompts" || sub === "read")) {
          // Live-client subcommands (resources/prompts) need a connected client (#219).
          let text: string;
          if (sub === "resources") text = await agent.mcpResourcesReport(rest[0] ?? "");
          else if (sub === "prompts") text = await agent.mcpPromptsReport(rest[0] ?? "");
          else text = rest[1] ? await agent.mcpReadResource(rest[0], rest[1]) : "Usage: /mcp read <server> <uri>";
          yield { type: "text", text } as const;
        } else if (sub === "auth") {
          // Interactive OAuth authorization-code + PKCE flow (#199).
          if (!rest[0]) {
            yield { type: "text", text: "Usage: /mcp auth <server>" } as const;
          } else {
            yield { type: "text", text: `Opening your browser to authorize "${rest[0]}"…` } as const;
            const { runMcpOAuth } = await import("../mcp/oauth-flow.js");
            yield { type: "text", text: await runMcpOAuth(rest[0]) } as const;
          }
        } else {
          yield { type: "text", text: handleMcpCommand(args) } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/vim" || input.startsWith("/vim ")) {
        const arg = input.slice(4).trim();
        if (arg === "help") {
          yield { type: "text", text: VIM_HELP } as const;
        } else {
          const cfg = loadXdgConfig();
          const next = arg === "on" ? true : arg === "off" ? false : !cfg.vimMode;
          saveXdgConfig({ ...cfg, vimMode: next });
          setVimMode(next);
          yield { type: "text", text: `Vim mode ${next ? "ON" : "OFF"}.${next ? " (/vim help for keys)" : ""}` } as const;
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/diagnostics") {
        yield { type: "text", text: diagnosticsReport() } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/allow" || input.startsWith("/allow ")) {
        const text = handleAllowCommand(input.slice(6));
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/retry" || input === "/edit" || input.startsWith("/edit ")) {
        // Bare /edit must print usage BEFORE popping anything — previously it
        // silently behaved like /retry, discarding the last answer and burning a
        // full model run the user didn't ask for.
        if (input === "/edit" || (input.startsWith("/edit ") && !input.slice(6).trim())) {
          yield { type: "text", text: "Usage: /edit <new prompt>  (or /retry to re-run the last prompt unchanged)" } as const;
          yield { type: "done" } as const;
          return;
        }
        const agent = agentRef.current;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
          yield { type: "done" } as const;
          return;
        }
        const original = agent.popLastExchange();
        if (original === null) {
          yield { type: "text", text: "Nothing to retry yet." } as const;
          yield { type: "done" } as const;
          return;
        }
        const newText = input.startsWith("/edit ") ? input.slice(6).trim() : original;
        // Re-sync the chat view to the trimmed history, then re-run the turn.
        replaceMessages(restoredToChatMessages(agent.conversation()));
        setScrollOffset(0);
        // popLastExchange re-stages the popped turn's images so /retry and
        // /edit send them again (#375) — reflect that in the indicator.
        setStagedImages(agent.pendingImageCount());
        yield { type: "text", text: `↻ ${newText}\n` } as const;
        yield* agent.run(newText, signal);
        return;
      }

      if (input === "/copy" || input.startsWith("/copy ")) {
        yield { type: "text", text: handleCopyCommand(input.slice(5), messages.map((m) => ({ role: m.role, content: m.content }))) } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/search" || input.startsWith("/search ")) {
        // In-conversation transcript search (#353). Past sessions are covered by
        // `/resume search <text>`; this finds text in the CURRENT scrollback.
        const q = input.slice(8).trim();
        if (!q) {
          yield { type: "text", text: "Usage: /search <text> — find matches in this conversation. (Past sessions: /resume search <text>)" } as const;
          yield { type: "done" } as const;
          return;
        }
        const needle = q.toLowerCase();
        const hits: string[] = [];
        messages.forEach((m, i) => {
          const idx = m.content.toLowerCase().indexOf(needle);
          if (idx === -1) return;
          const start = Math.max(0, idx - 40);
          const end = Math.min(m.content.length, idx + q.length + 40);
          const snippet = `${start > 0 ? "…" : ""}${m.content.slice(start, end).replace(/\s+/g, " ").trim()}${end < m.content.length ? "…" : ""}`;
          const who = m.role === "user" ? "You" : m.role === "assistant" ? "AI" : "Sys";
          hits.push(`  msg ${i + 1}/${messages.length} ${who}: ${snippet}`);
        });
        const text = hits.length
          ? `${hits.length} match${hits.length === 1 ? "" : "es"} for "${q}":\n${hits.slice(0, 12).join("\n")}${hits.length > 12 ? `\n  …(+${hits.length - 12} more)` : ""}\n(PgUp/PgDn scrolls the transcript to a message)`
          : `No matches for "${q}" in this conversation. Past sessions: /resume search <text>.`;
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/branch") {
        const id = agentRef.current?.branchSession();
        yield { type: "text", text: id ? `Branched into a new session (${id}). Continuing here; the original is in /resume.` : "Branching unavailable (no session store)." } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/remember" || input.startsWith("/remember ")) {
        const text = agentRef.current?.rememberFact(input.slice(9).trim()) ?? "Agent not initialised.";
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/rag" || input.startsWith("/rag ")) {
        const root = agentRef.current?.projectRootPath ?? process.cwd();
        // Reuse the live-tool panel for per-file indexing progress (#343); it
        // clears automatically when the turn ends.
        const text = await handleRagCommand(input.slice(4), root, (msg) => setLiveTool({ name: "rag indexing", tail: msg }));
        yield { type: "text", text } as const;
        yield { type: "done" } as const;
        return;
      }

      if (input === "/image" || input.startsWith("/image ")) {
        const agent = agentRef.current;
        if (!agent) {
          yield { type: "text", text: "Agent not initialised." } as const;
        } else {
          const { url, error } = buildImageUrl(input.slice(6));
          if (error) {
            yield { type: "text", text: error } as const;
          } else if (url) {
            agent.stageImage(url);
            setStagedImages(agent.pendingImageCount());
            yield { type: "text", text: `Attached image (${agent.pendingImageCount()} staged). Ask your question about it next — needs a vision-capable model.` } as const;
          }
        }
        yield { type: "done" } as const;
        return;
      }

      if (input === "/prompt" || input.startsWith("/prompt ")) {
        const result = handlePromptCommand(input.slice(7));
        if (result.kind === "message") {
          yield { type: "text", text: result.text } as const;
          yield { type: "done" } as const;
          return;
        }
        // Expanded a saved template → run it as a normal turn.
        if (!agentRef.current) {
          yield { type: "error", message: agentError ?? "Agent not initialised." } as const;
          yield { type: "done" } as const;
          return;
        }
        yield { type: "text", text: `▸ ${result.prompt}\n` } as const;
        yield* agentRef.current.run(result.prompt, signal);
        return;
      }

      if (input === "/models" || input.startsWith("/models ")) {
        const arg = input.slice(7).trim();
        const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
        const name = rest.join(" ");
        if (!sub || sub === "list" || sub === "ls") {
          yield { type: "text", text: await listModelsText() } as const;
        } else if (sub === "pull") {
          for await (const line of pullModelProgress(name)) {
            yield { type: "text", text: line + "\n" } as const;
          }
        } else if (sub === "delete" || sub === "rm") {
          yield { type: "text", text: await deleteModelText(name) } as const;
        } else {
          yield { type: "text", text: "Usage: /models [list | pull <name> | delete <name>]" } as const;
        }
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

      if (input === "/workspace" || input.startsWith("/workspace ")) {
        const wsPath = input === "/workspace" ? "" : input.slice(11).trim();
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

      if (input === "/apikey" || input.startsWith("/apikey ")) {
        const newKey = input === "/apikey" ? "" : input.slice(8).trim();
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

      if (input === "/model" || input.startsWith("/model ")) {
        if (input === "/model" || !input.slice(7).trim()) {
          // Bare /model opens the PICKER rather than printing usage: typing
          // model names by hand is error-prone (and cloud names like
          // "deepseek-v4-flash:0731" are easy to misspell). The picker lists
          // what the active provider actually serves.
          setShowModelSelection(true);
          yield { type: "text", text: `Pick a model for ${activeProvider} (↑↓ to move, Enter to select, Esc to cancel). Current: ${activeModel}` } as const;
          yield { type: "done" } as const;
          return;
        }
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

      // User-defined slash commands (.metalmind/commands/<name>.md): run the
      // template as the prompt. Unknown /commands get a hint instead of being
      // sent to the LLM as literal chat.
      if (input.startsWith("/")) {
        const m = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(input);
        if (m) {
          const uc = loadUserCommands(agentRef.current.projectRootPath ?? process.cwd()).find((c) => c.name === m[1]);
          if (uc) {
            yield { type: "text", text: `⚡ /${uc.name}\n` } as const;
            yield* agentRef.current.run(expandUserCommand(uc, m[2]?.trim() ?? ""), signal);
            return;
          }
          yield {
            type: "text",
            text: `Unknown command /${m[1]}. /help lists built-ins; define your own as .metalmind/commands/${m[1]}.md (the file's content becomes the prompt, $ARGUMENTS = your args).`,
          } as const;
          yield { type: "done" } as const;
          return;
        }
      }

      yield* agentRef.current.run(input, signal);
    },
    // Agent notices (truncation, provider fallback, tier escalation) were shown
    // for a single frame with no record anywhere. Route them to the notification
    // system so /notifications keeps a text-only history (#429).
    onNotice: (text) => {
      const clean = text.replace(/^\s*\[|\]\s*$/g, "").trim();
      if (clean) notify("info", clean);
    },
  });

  // Keep the pre-declared ref in sync for callbacks defined above useChat.
  isStreamingRef.current = isStreaming;

  const handleSend = useCallback((text: string) => {
    setScrollOffset(0); // jump back to the live tail on a new turn (#159)
    setLiveTool(null);
    setStagedImages(0); // the staged images ride along with this message (#375)
    sendMessage(text);
  }, [sendMessage]);

  // A reload deferred because a turn was in flight retries as soon as the turn
  // ends, so the config the user already saved actually takes effect (#440).
  useEffect(() => {
    if (isStreaming || !pendingReloadRef.current) return;
    pendingReloadRef.current = false;
    notify("info", "Applying the deferred model/provider switch…");
    void reloadAgent();
  }, [isStreaming, reloadAgent]);

  // Re-run the startup health probe when a turn finishes (#417). The warning
  // was set once at launch and never revisited, so a user who followed its own
  // advice — start ollama, pull the model, set a key — kept staring at a stale
  // alarm for the rest of the session with no way to clear it.
  useEffect(() => {
    if (isStreaming) return;
    const agent = agentRef.current;
    if (!agent) return;
    let cancelled = false;
    void agent.checkHealth().then((h) => {
      if (!cancelled) setHealthWarning(h.ok ? null : h.message);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isStreaming]);

  // Track how long the model has been reasoning (#344).
  useEffect(() => {
    if (streamingReasoning && reasoningStartRef.current === null) {
      reasoningStartRef.current = Date.now();
    }
    if (!streamingReasoning) {
      reasoningStartRef.current = null;
      setReasoningSecs(0);
      return;
    }
    const t = setInterval(() => {
      if (reasoningStartRef.current !== null) setReasoningSecs(Math.floor((Date.now() - reasoningStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [streamingReasoning !== ""]);

  // Drop the live tool tail once the turn finishes.
  useEffect(() => {
    if (!isStreaming) setLiveTool(null);
  }, [isStreaming]);
  // …and as soon as the running tool's RESULT lands, so a finished command's
  // last output doesn't sit under a stale "(live)" label for the rest of the
  // turn (#357).
  useEffect(() => {
    const last = activeToolCalls[activeToolCalls.length - 1];
    if (last?.output !== undefined) setLiveTool(null);
  }, [activeToolCalls]);

  // Any modal overlay is open: each overlay owns its own input, so the global
  // key handler and the chat InputBar must stand down to avoid double-handling (#254).
  const anyOverlayOpen =
    showCommandPalette || showProviderSelection || showModelSelection ||
    showMcpConfig || showThemeSelection || showFileTree || tierModelPickerFor !== null;
  // An approval prompt is MODAL (#439). Overlays register their own useInput, so
  // while both were mounted every keystroke reached BOTH handlers — typing "a"
  // into the API-key field or the palette silently answered the approval with
  // "always allow". Overlays are unmounted (not merely ignored) for the
  // duration, which also removes their input handlers.
  const overlaysVisible = anyOverlayOpen && pendingApproval === null;

  useInput((input, key) => {
    // Approval prompt takes priority over all other input while it's open (#138).
    if (pendingApproval) {
      if (input === "y" || key.return) {
        pendingApproval.resolve("approve");
        setPendingApproval(null);
        setApprovalScroll(0);
      } else if (input === "a") {
        pendingApproval.resolve("always");
        setPendingApproval(null);
        setApprovalScroll(0);
      } else if (input === "n" || key.escape) {
        pendingApproval.resolve("reject");
        setPendingApproval(null);
        setApprovalScroll(0);
      } else if (input === "j" || key.pageDown) {
        // Scroll a long approval diff — approving big writes blind was the
        // only option before.
        setApprovalScroll((v) => v + 10);
      } else if (input === "k" || key.pageUp) {
        setApprovalScroll((v) => Math.max(0, v - 10));
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
    if (key.ctrl && input === "o") setStatusCollapsed(prev => !prev); // toggle Models panel (#266)
    // Scrollback: PgUp/PgDn page the transcript; End jumps back to the latest (#159).
    if (key.pageUp) setScrollOffset(prev => prev + chatPageSize);
    if (key.pageDown) setScrollOffset(prev => Math.max(0, prev - chatPageSize));
    if (input === "G") setScrollOffset(0);
  }, { isActive: !anyOverlayOpen || pendingApproval !== null }); // approval keys must ALWAYS win, even under an overlay

  const getActiveModel = () => {
    if (forcedTier !== null) {
      const override = tierModels[forcedTier];
      const modelLabel = override ? `${override.provider}/${override.model}` : activeModel;
      const tierSuffix = ` [tier${forcedTier} locked]`;
      return modelLabel + tierSuffix;
    }
    return activeModel;
  };

  // The live route for the status panel's "Main", parsed from activeModel (which
  // every route/model-switch updates) so it tracks the active model rather than
  // the startup config (#248). Strips the " [tier…]" suffix, splits on the first
  // "/"; provider has no slash and configured models use ":" tags, not "/".
  const activeMain = (() => {
    const base = activeModel.replace(/\s*\[[^\]]*\]\s*$/, "");
    const slash = base.indexOf("/");
    return slash >= 0
      ? { provider: base.slice(0, slash), model: base.slice(slash + 1) }
      : { provider: config.provider, model: base };
  })();

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Header projectName={projectName} modelName={getActiveModel()} accent={theme.colors.accent} />
      <ChatView messages={messages} streamingContent={streamingContent} activeToolCalls={activeToolCalls} isStreaming={isStreaming} accent={theme.colors.accent} scrollOffset={scrollOffset} pageSize={chatPageSize} />
      {streamingReasoning && !streamingContent && (
        <Box>
          <Text color="gray" dimColor>{"💭 "}reasoning ({Math.round(streamingReasoning.length / 4)} tokens{reasoningSecs > 0 ? `, ${reasoningSecs}s` : ""})… {streamingReasoning.replace(/\s+/g, " ").slice(-160)}</Text>
        </Box>
      )}
      {isStreaming && liveTool && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold dimColor>▸ {liveTool.name} (live)</Text>
          {sanitizeForDisplay(liveTool.tail).split("\n").filter(Boolean).slice(-4).map((l, i) => (
            <Text key={i} dimColor wrap="truncate-end">{sanitizeAndTruncate(l, 160)}</Text>
          ))}
        </Box>
      )}
      <MultiAgentStatus
        mainModel={activeMain.model}
        mainProvider={activeMain.provider}
        localWorkerModel={localWorkerModel}
        localWorkerProvider={localWorkerProvider}
        localWorkerAvailable={localWorkerAvailable}
        phase={coordinatorPhase}
        currentRouting={currentRouting}
        planSteps={planSteps}
        collapsed={statusCollapsed}
      />
      {healthWarning && (
        <Box>
          <Text color="yellow">⚠ {healthWarning} <Text dimColor>(re-checked after each turn; /doctor for detail)</Text></Text>
        </Box>
      )}
      <Notifications items={notifications} />
      {todos.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold dimColor>Tasks ({todos.filter((t) => t.status === "completed").length}/{todos.length})</Text>
          {todos.slice(0, 8).map((t, i) => (
            <Text key={i} color={t.status === "completed" ? "green" : t.status === "in_progress" ? "yellow" : undefined} dimColor={t.status === "pending"}>
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·"} {t.text}
            </Text>
          ))}
          {todos.length > 8 && <Text dimColor>… {todos.length - 8} more</Text>}
        </Box>
      )}
      {pendingApproval && <ApprovalView req={pendingApproval.req} accent={theme.colors.accent} diffScroll={approvalScroll} />}
      <InputBar onSubmit={handleSend} disabled={isStreaming || pendingApproval !== null || anyOverlayOpen} vimMode={vimMode} projectRoot={agentRef.current?.projectRootPath ?? process.cwd()} insertText={pendingInsert} />
      {stagedImages > 0 && (
        <Box>
          <Text color="magenta">🖼 {stagedImages} image{stagedImages === 1 ? "" : "s"} attached to your next message</Text>
        </Box>
      )}
      <StatusBar focusPanel={focusPanel} isStreaming={isStreaming} context={contextUsage} usage={usage} mode={agentMode} mcpServers={mcpServers} evaluateEachPrompt={evaluateEachPrompt} forcedTier={forcedTier} />

      {overlaysVisible && showCommandPalette && (
        <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} accent={theme.colors.accent}
          commands={[
            { id: "tier-auto", title: "Tier: Auto", description: "Let router pick tier per request", action: () => applyForcedTier(null) },
            { id: "tier-1", title: "Tier 1: MLX GPU", description: "Choose + force local MLX model", action: () => setTierModelPickerFor(1) },
            { id: "tier-2", title: "Tier 2: Local Ollama", description: "Choose + force local Ollama model", action: () => setTierModelPickerFor(2) },
            { id: "tier-3", title: "Tier 3: Cloud brain", description: "Choose + force Ollama Cloud model", action: () => setTierModelPickerFor(3) },
            { id: "routing", title: "Routing: Auto ⇄ Cloud-only", description: "Evaluate each prompt for a tier, or always use tier 3", action: () => {
              const agent = agentRef.current;
              if (!agent) return;
              const next = !agent.getEvaluateEachPrompt();
              notify("info", agent.setEvaluateEachPrompt(next));
              setEvaluateEachPrompt(next);
            } },
            { id: "provider", title: "Remote Provider", description: "Cloud provider for complex tasks", action: () => setShowProviderSelection(true) },
            { id: "model", title: "Remote Model", description: "Model used for complex tasks", action: () => setShowModelSelection(true) },
            { id: "mcp", title: "MCP", description: "Configure MCP servers", action: () => setShowMcpConfig(true) },
            { id: "theme", title: "Theme", description: "Switch theme (light/dark)", action: () => setShowThemeSelection(true) },
            { id: "files", title: "File Tree", description: "Browse the project files", action: () => setShowFileTree(true) },
          ]}
        />
      )}
      {overlaysVisible && showProviderSelection && (
        <ProviderSelection onSelect={async (providerId) => {
          setShowProviderSelection(false);
          setActiveProvider(providerId);
          const newCfg = resolveConfig();
          setActiveModel(`${newCfg.provider}/${newCfg.model}`);
          await reloadAgent();
        }} onCancel={() => setShowProviderSelection(false)} accent={theme.colors.accent} />
      )}
      {overlaysVisible && showModelSelection && (
        <ModelSelection providerId={activeProvider} onSelect={async (modelId) => {
          setShowModelSelection(false);
          setActiveModel(`${activeProvider}/${modelId}`);
          await reloadAgent();
        }} onCancel={() => setShowModelSelection(false)} accent={theme.colors.accent} />
      )}
      {overlaysVisible && showMcpConfig && <McpConfig onDone={() => setShowMcpConfig(false)} accent={theme.colors.accent} />}
      {overlaysVisible && showFileTree && (
        <FileTree
          root={agentRef.current?.projectRootPath ?? process.cwd()}
          onClose={() => setShowFileTree(false)}
          accent={theme.colors.accent}
          onSelectFile={(rel) => setPendingInsert({ text: formatMention(rel), nonce: Date.now() })}
        />
      )}
      {overlaysVisible && tierModelPickerFor !== null && (
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
      {overlaysVisible && showThemeSelection && (
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
