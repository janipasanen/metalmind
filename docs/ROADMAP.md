# MetalMind Roadmap

> Generated from a comprehensive, evidence-verified gap analysis of the codebase (7 subsystems analyzed, 68 candidate gaps, all confirmed against real code). Each item below is a tracked GitHub issue.

## Implementation order (first wave)

1. #131 — Fix OpenAI tool-result round-trip: emit tool_call_id on tool-role messages
1. #135 — Thread an AbortSignal through ChatCompletionRequest to every provider fetch
1. #136 — Wire Esc-to-interrupt: propagate cancel from key handler through agent loop
1. #134 — Add status-aware retry/backoff and cross-tier fallback on transient provider errors
1. #142 — Register code-intelligence tools (findSymbol/findReferences/getCallGraph/getDiagnostics) with the agent

## M1 · Provider correctness & turn survival

*providers, reliability*

The product is fundamentally tool-driven, yet OpenAI multi-turn tool loops 400 on the second call (missing tool_call_id), Anthropic never sends tools at all (text-only), transient 429/5xx aborts every turn with no retry/fallback, and mid-stream SSE error events are silently swallowed and reported as success. Until a turn can reliably complete on the configured provider, every higher-level feature is built on sand. This milestone also lands the shared stream-contract extension (an `error` event variant on ModelStreamEvent) that mid-stream surfacing, retry/fallback, and later cost display all depend on. Build first because nothing else matters if a basic agent turn cannot survive a provider quirk.

| # | Pri | Sev | Eff | Issue |
|---|-----|-----|-----|-------|
| #131 | P1 | critical | S | Fix OpenAI tool-result round-trip: emit tool_call_id on tool-role messages |
| #132 | P2 | critical | L | Add Anthropic request-side tool-calling (send tools + tool_use/tool_result blocks) |
| #133 | P3 | high | S | Surface mid-stream SSE error events instead of silently completing |
| #134 | P4 | critical | M | Add status-aware retry/backoff and cross-tier fallback on transient provider errors |
| #148 | P18 | low | S | Fix Ollama worker model prefix-match false positives |

## M2 · Interrupt, timeout & abort plumbing

*reliability, ux*

Thread a single AbortSignal through ChatCompletionRequest -> every provider fetch -> the agent loop -> useChat, then wire Esc to it and add per-request timeouts. This is one coherent unit of work: the signal field, the consumer wiring, and the UI key handler are interdependent and pointless apart. It removes the dead 'Esc: cancel' affordance the UI already advertises, stops cloud billing on a runaway turn, and prevents a hung sidecar from wedging the TUI forever. Depends on M1 only loosely (shared request-type edits) and unblocks trustworthy use of the agent. High value, mostly small/medium.

| # | Pri | Sev | Eff | Issue |
|---|-----|-----|-----|-------|
| #135 | P5 | high | M | Thread an AbortSignal through ChatCompletionRequest to every provider fetch |
| #136 | P6 | critical | S | Wire Esc-to-interrupt: propagate cancel from key handler through agent loop |
| #137 | P7 | high | M | Add connection/read timeouts to all chat and stream calls |

## M3 · Human-in-the-loop trust: approval, undo, sandbox & audit

*safety, ux*

The single biggest trust gap versus every production coding agent: writes, git mutations, and arbitrary shell commands execute autonomously with no diff review, no approval prompt, a trivially-bypassable substring denylist, and no recovery. This milestone wires the existing-but-dead scaffolding (DiffView, PermissionManager, SafetyValidator.validateShellCommand, AuditLog) into the one agenticLoop execution path: an interactive approve/reject/always-allow gate with diff preview, a real shell-command validator, an /undo safety net, and an in-session audit trail. Grouped because they all hook the same choke point and reinforce one another. Comes after interrupt plumbing (M2) since a user must be able to stop a turn before fine-grained approval is meaningful.

| # | Pri | Sev | Eff | Issue |
|---|-----|-----|-----|-------|
| #138 | P8 | critical | L | Add interactive edit/command approval gate with diff preview and accept/reject/always-allow |
| #139 | P9 | high | S | Route shell commands through the regex SafetyValidator and add path/secret checks |
| #144 | P14 | medium | M | Add /undo to revert the agent's last applied edit set |
| #147 | P17 | medium | M | Capture and surface a tool-call audit log in-session |

## M4 · Session lifecycle & context management

*ux, reliability*

Long agentic sessions currently lose all context on exit, silently overflow small local-tier context windows, and offer no way to resume, compact, or export. Wire the built-and-tested SqliteSessionStore for persistence/resume, add token-budget tracking against the active model limit with /compact summarization, load a project memory file into the system prompt, and add transcript export. These features share the history/persistence subsystem and the token-counting work, so they ship together. Depends on accurate token counting (started in M1's usage plumbing) and benefits from a stable turn loop.

| # | Pri | Sev | Eff | Issue |
|---|-----|-----|-----|-------|
| #140 | P10 | high | M | Persist conversation history and add session resume (/resume, --continue) |
| #141 | P11 | high | M | Track conversation tokens against the model context limit and trim/manage history |
| #145 | P15 | medium | L | Add /compact to summarize older turns when history grows |
| #146 | P16 | medium | M | Load a project memory/rules file into the system prompt |
| #154 | P24 | low | S | Add transcript export (/export to Markdown/JSON) |

## M5 · Code intelligence, retrieval & richer tooling

*tooling, code-intelligence*

A large amount of capability is already built but unreachable: symbol/reference/call-graph/diagnostics tools, RepoMapV2, ContextBudgetOptimizer, stdio MCP, skills. Register the code-intel tools, populate and refresh the reference index, auto-inject a token-bounded repo map, surface diagnostics after edits, add web fetch/search, multi-file atomic edits, background shell, formatter-on-write, stdio MCP transport with namespacing, and skills discovery. These multiply agent effectiveness on real tasks and largely reuse existing dead code. Lands after the safety gate (M3) so newly-exposed, more-powerful tools run under approval.

| # | Pri | Sev | Eff | Issue |
|---|-----|-----|-----|-------|
| #142 | P12 | high | S | Register code-intelligence tools (findSymbol/findReferences/getCallGraph/getDiagnostics) with the agent |
| #143 | P13 | high | M | Auto-inject a token-bounded repo map into the system prompt |
| #149 | P19 | high | M | Populate and incrementally refresh the symbol/reference index |
| #150 | P20 | high | M | Add web fetch and web search tools |
| #151 | P21 | high | M | Add a multi-file atomic apply-patch / multi-edit tool with rollback |
| #152 | P22 | medium | M | Surface diagnostics automatically after edits (lint/typecheck feedback loop) |
| #153 | P23 | medium | M | Add background / long-running shell processes with log polling and stop |
| #155 | P25 | high | M | Add MCP stdio transport to the TUI runtime |
| #156 | P26 | high | M | Wire skills discovery and invocation into the TUI |
| #161 | P31 | low | S | Namespace MCP tool names to prevent cross-server collisions |
| #162 | P32 | low | S | Add a formatter tool and post-edit auto-format |
| #163 | P33 | low | S | Replace naive findFiles walk with ripgrep/fd respecting ignore files |
| #164 | P34 | low | M | Add a project-wide find-and-replace / symbol-rename tool |

## M6 · Observability, planning & TUI polish

*ux, observability*

The remaining quality-of-life and differentiation layer: live token/cost meters and per-tier routing telemetry, coordinator-path quality gate + escalation, planning/task-decomposition, parallel sub-agents, scrollback/paging, multiline input, @-file mentions, syntax highlighting, copy-to-clipboard, vim/configurable keybindings, secrets redaction/keychain, MCP lifecycle UX, worker-cache and budget wiring, and dead-command cleanup. These are polish and depth that sit on top of a correct, safe, persistent core. Ordered last by value-after-foundation; many are small but none are load-bearing for basic operation.

| # | Pri | Sev | Eff | Issue |
|---|-----|-----|-----|-------|
| #157 | P27 | high | M | Extract and surface token/cost usage end-to-end |
| #158 | P28 | high | M | Apply quality gate and escalation in the coordinator (default) path |
| #159 | P29 | high | L | Add scrollback and paging for long chat and tool output |
| #160 | P30 | medium | M | Add multiline input and bracketed-paste handling |
| #165 | P35 | medium | M | Add per-tier routing telemetry and a routing log |
| #166 | P36 | medium | L | Implement planning / task decomposition in the coordinator |
| #167 | P37 | medium | M | Add @-file mentions and filesystem path autocomplete in the input |
| #168 | P38 | medium | M | Add secrets redaction and optional macOS keychain storage |
| #169 | P39 | medium | M | Add MCP server lifecycle/health UX (status, errors, tool counts, reconnect) |
| #170 | P40 | medium | M | Add accurate provider token counting |
| #171 | P41 | low | M | Add syntax highlighting for fenced code blocks |
| #172 | P42 | low | M | Add copy-to-clipboard for messages, code, and diffs |
| #173 | P43 | medium | M | Add Anthropic prompt caching and extended-thinking parameters |
| #174 | P44 | medium | M | Add provider health checks and model/key validation at startup |
| #175 | P45 | medium | M | Harden worker JSON-mode structured output (full schema + repair/validate) |
| #176 | P46 | medium | M | Add edit undo/redo checkpointing as a user-facing safety net |
| #177 | P47 | medium | L | Add image/screenshot/vision input channel |
| #178 | P48 | medium | L | Add LSP-backed go-to-definition, references, and hover |
| #179 | P49 | medium | XL | Add semantic/embeddings code search and query-aware file selection |
| #180 | P50 | medium | L | Add parallel sub-agents for independent worker tasks |
| #181 | P51 | low | M | Route real repeated worker tasks through the result cache |
| #182 | P52 | low | S | Surface and enforce a configurable spend budget |
| #183 | P53 | low | S | Clean up dead command file and sync slash-command autocomplete |
| #184 | P54 | low | L | Add vim mode and configurable keybindings with a help overlay |
