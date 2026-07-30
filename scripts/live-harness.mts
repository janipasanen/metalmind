/**
 * Live functional harness (#352): exercises the REAL provider + AgentLoop code
 * paths against an actual Ollama Cloud model — streaming, tool calls, the full
 * agent loop with tool execution, mid-stream abort, and secret redaction.
 *
 * Run:  npm run test:live          (needs OLLAMA_API_KEY in the environment)
 * Env:  MM_TEST_MODEL              override the model (default gemma4:31b)
 *       OLLAMA_CLOUD_BASE_URL      override the endpoint
 *
 * Exits 0 with a SKIPPED notice when no API key is set, so it can run in
 * pipelines unconditionally; exits 1 on any failed check.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@metalmind/providers";
import type { ModelStreamEvent, ChatCompletionRequest } from "@metalmind/core";
import { AgentLoop } from "../apps/tui/src/agent.js";

const KEY = process.env.OLLAMA_API_KEY;
const BASE = process.env.OLLAMA_CLOUD_BASE_URL || "https://api.ollama.com";
const MODEL = process.env.MM_TEST_MODEL || "gemma4:31b";
if (!KEY) {
  console.log("SKIPPED: OLLAMA_API_KEY not set — live harness needs a real cloud key.");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  cond ? pass++ : fail++;
};
const collect = async (gen: AsyncGenerator<ModelStreamEvent>) => {
  const events: ModelStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
};

async function main() {
  const provider = createProvider("ollama-cloud", MODEL, { apiKey: KEY, baseUrl: BASE });

  // 1) streaming chat
  {
    const t = Date.now();
    const events = await collect(provider.streamChatCompletion({ messages: [{ role: "user", content: "Say exactly: hello world" }] } as ChatCompletionRequest));
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    ok("stream: text emitted", text.toLowerCase().includes("hello"), `"${text.trim().slice(0, 40)}" ${Date.now() - t}ms`);
    ok("stream: ends with done", events.at(-1)?.type === "done");
    ok("stream: usage event present", events.some((e) => e.type === "usage"));
  }

  // 2) completeChat (non-streaming)
  {
    const res = await provider.completeChat({ messages: [{ role: "user", content: "Reply with only: 42" }] } as ChatCompletionRequest);
    ok("completeChat: content", res.message.content.includes("42"), JSON.stringify(res.message.content).slice(0, 40));
  }

  // 3) streaming + tools → tool-call event with valid JSON arguments
  {
    const events = await collect(provider.streamChatCompletion({
      messages: [{ role: "user", content: "List files in the current directory using the listDir tool." }],
      tools: [{ name: "listDir", description: "List directory contents", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    } as ChatCompletionRequest));
    const calls = events.filter((e) => e.type === "tool-call") as Array<{ toolCall: { toolName: string; argumentsJson: string } }>;
    ok("stream+tools: emits tool-call", calls.length > 0, calls.map((c) => `${c.toolCall.toolName}(${c.toolCall.argumentsJson})`).join(", "));
    if (calls.length) {
      let parsed = false;
      try { JSON.parse(calls[0].toolCall.argumentsJson); parsed = true; } catch { /* invalid */ }
      ok("stream+tools: argumentsJson is valid JSON", parsed, calls[0].toolCall.argumentsJson);
    }
  }

  // 4) FULL agent loop with a real read-only tool use
  {
    const root = mkdtempSync(join(tmpdir(), "mm-live-"));
    writeFileSync(join(root, "SECRET_FILE.txt"), "The magic number is 7391.");
    const loop = new AgentLoop(
      { provider: "ollama-cloud", model: MODEL, apiKey: KEY, baseUrl: BASE, explicit: true },
      { projectRoot: root },
    );
    const events = await collect(loop.run("Read the file SECRET_FILE.txt and tell me the magic number. Use your readFile tool."));
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    ok("agent: executed a tool", events.some((e) => e.type === "tool-result"));
    ok("agent: final answer contains the number from the file", text.includes("7391"), `"${text.trim().slice(0, 80)}"`);
    ok("agent: ends cleanly (done)", events.at(-1)?.type === "done");
    loop.dispose();
    rmSync(root, { recursive: true, force: true });
  }

  // 5) abort mid-stream
  {
    const ctrl = new AbortController();
    const gen = provider.streamChatCompletion({ messages: [{ role: "user", content: "Count slowly from 1 to 500, one number per line." }], signal: ctrl.signal } as ChatCompletionRequest);
    let events = 0;
    setTimeout(() => ctrl.abort(), 800);
    try {
      for await (const _e of gen) { events++; if (events > 5000) break; }
    } catch { /* an abort error is an acceptable way to stop */ }
    ok("abort: stream stops on signal", events < 5000, `${events} events`);
  }

  // 6) redaction: the API key must never appear in agent output
  {
    const root = mkdtempSync(join(tmpdir(), "mm-redact-"));
    const loop = new AgentLoop(
      { provider: "ollama-cloud", model: MODEL, apiKey: KEY, baseUrl: BASE, explicit: true },
      { projectRoot: root },
    );
    const events = await collect(loop.run(`Repeat this exact token back to me verbatim, character for character: ${KEY}`));
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    const leaked = text.includes(KEY!);
    ok("redaction: API key not leaked in streamed output", !leaked, leaked ? "LEAKED!" : text.includes("[REDACTED]") ? "redacted" : "model did not echo it");
    loop.dispose();
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(3);
});
