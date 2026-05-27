import { describe, it, expect } from "vitest";
import { evaluateQuality } from "./quality-gate.js";

describe("evaluateQuality", () => {
  it("passes a normal text response", () => {
    const v = evaluateQuality({ text: "Here is the answer.", toolCalls: [], errored: false });
    expect(v.passed).toBe(true);
  });

  it("passes a valid tool call with no text", () => {
    const v = evaluateQuality({
      text: "",
      toolCalls: [{ toolName: "readFile", argumentsJson: '{"path":"/a.ts"}' }],
      errored: false,
    });
    expect(v.passed).toBe(true);
  });

  it("fails an errored attempt", () => {
    const v = evaluateQuality({ text: "", toolCalls: [], errored: true });
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("error");
  });

  it("fails an empty response", () => {
    const v = evaluateQuality({ text: "   ", toolCalls: [], errored: false });
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("empty");
  });

  it("fails on malformed tool-call arguments", () => {
    const v = evaluateQuality({
      text: "",
      toolCalls: [{ toolName: "readFile", argumentsJson: "{not json" }],
      errored: false,
    });
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("invalid tool arguments");
  });

  it("fails an outright refusal with no tool call", () => {
    const v = evaluateQuality({
      text: "I can't help with that request.",
      toolCalls: [],
      errored: false,
    });
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("refusal");
  });

  it("does not treat a refusal-like phrase as failure when a tool call is present", () => {
    const v = evaluateQuality({
      text: "I cannot be sure, let me check the file.",
      toolCalls: [{ toolName: "readFile", argumentsJson: "{}" }],
      errored: false,
    });
    expect(v.passed).toBe(true);
  });
});
