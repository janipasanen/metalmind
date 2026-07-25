import { describe, it, expect } from "vitest";
import { Redactor, StreamRedactor, collectSecrets } from "../redact.js";

describe("StreamRedactor — secrets split across stream chunks (#168 stream)", () => {
  const SECRET = "225cae0f1234567890abcdefghijklmnop7qTz"; // 38 chars

  it("scrubs a secret even when it arrives one character at a time", () => {
    const sr = new StreamRedactor(new Redactor([SECRET]));
    let out = "";
    for (const ch of `token is ${SECRET} ok`) out += sr.push(ch);
    out += sr.flush();
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toBe("token is [REDACTED] ok");
  });

  it("scrubs a secret split into two awkward chunks", () => {
    const sr = new StreamRedactor(new Redactor([SECRET]));
    const mid = Math.floor(SECRET.length / 2);
    let out = sr.push(`the key: ${SECRET.slice(0, mid)}`);
    out += sr.push(`${SECRET.slice(mid)}. done.`);
    out += sr.flush();
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("streams ordinary text through without holding it back", () => {
    const sr = new StreamRedactor(new Redactor([SECRET]));
    let out = "";
    for (const ch of "hello world, this is fine") out += sr.push(ch);
    out += sr.flush();
    expect(out).toBe("hello world, this is fine");
  });

  it("holds back a trailing partial-secret prefix until flush", () => {
    const sr = new StreamRedactor(new Redactor([SECRET]));
    // A chunk ending in a genuine secret prefix must not be emitted yet.
    const emitted = sr.push(`x ${SECRET.slice(0, 20)}`);
    expect(emitted).not.toContain(SECRET.slice(0, 20));
    // If it never completes, flush emits it verbatim (it wasn't actually a secret).
    const tail = sr.flush();
    expect(emitted + tail).toBe(`x ${SECRET.slice(0, 20)}`);
  });
});

describe("Redactor (#168)", () => {
  it("replaces known secret values with [REDACTED]", () => {
    const r = new Redactor(["sk-ant-abcdef123456", "ollama-key-9876543210"]);
    const out = r.redact("config: { anthropic: sk-ant-abcdef123456, ollama: ollama-key-9876543210 }");
    expect(out).not.toContain("sk-ant-abcdef123456");
    expect(out).not.toContain("ollama-key-9876543210");
    expect(out).toContain("[REDACTED]");
  });

  it("ignores short/empty values to avoid false positives", () => {
    const r = new Redactor(["", "abc", undefined, null]);
    expect(r.count).toBe(0);
    expect(r.redact("abc def")).toBe("abc def");
  });

  it("redacts the longest match first (no partial leak)", () => {
    const r = new Redactor(["secret12345", "secret12345-extended-token"]);
    const out = r.redact("token=secret12345-extended-token");
    expect(out).toBe("token=[REDACTED]");
  });

  it("collectSecrets gathers api keys + bearer tokens from MCP headers", () => {
    const secrets = collectSecrets(
      { anthropic: "sk-ant-longvalue123", ollama: "short" },
      ["cli-key-abcdefgh"],
      { srv: { headers: { Authorization: "Bearer tok-abcdefgh123456" } } },
    );
    expect(secrets).toContain("sk-ant-longvalue123");
    expect(secrets).toContain("cli-key-abcdefgh");
    expect(secrets).toContain("tok-abcdefgh123456"); // token extracted from Bearer
  });
});
