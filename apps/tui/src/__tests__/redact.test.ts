import { describe, it, expect } from "vitest";
import { Redactor, collectSecrets } from "../redact.js";

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
