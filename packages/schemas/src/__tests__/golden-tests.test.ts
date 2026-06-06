import { describe, it, expect } from "vitest";
import { RankRelevantFilesOutputSchema } from "@metalmind/schemas";
import fs from "node:fs";
import path from "node:path";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

describe("Golden tests - malformed model outputs", () => {
  it("should accept valid rank-files output", () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "local-worker-valid-rank-files.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const result = RankRelevantFilesOutputSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rankedFiles).toHaveLength(2);
      expect(result.data.confidence).toBeGreaterThanOrEqual(0);
      expect(result.data.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("should reject local worker output that is not valid JSON", () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "local-worker-invalid-json.md"), "utf-8");

    // The system should try to parse this as JSON and fail
    let parseResult: { success: boolean };
    try {
      const parsed = JSON.parse(raw);
      parseResult = { success: true };
    } catch {
      parseResult = { success: false };
    }

    expect(parseResult.success).toBe(false);
  });

  it("should reject deepseek malformed JSON where fields are wrong types", () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "deepseek-malformed-json.txt"), "utf-8");

    // This is not valid JSON at all
    let parseResult: { success: boolean };
    try {
      JSON.parse(raw);
      parseResult = { success: true };
    } catch {
      parseResult = { success: false };
    }

    expect(parseResult.success).toBe(false);
  });

  it("should handle cloud agent markdown with embedded tool calls", () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "cloud-agent-tool-call-markdown.md"), "utf-8");

    // Cloud agent output is markdown, not local worker JSON output
    // This should not be parseable as structured JSON
    expect(raw).toContain("```javascript");

    // If attempted to parse as JSON, it should fail
    expect(() => JSON.parse(raw)).toThrow();
  });

  it("should handle Ollama streaming output by parsing each line as JSON", () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, "ollama-streaming-output.txt"), "utf-8");

    // Each line should be parseable as JSON individually
    const lines = raw.trim().split("\n");
    let parsedCount = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.message) parsedCount++;
      } catch {
        // Some lines might be partial
      }
    }
    expect(parsedCount).toBeGreaterThan(0);
  });
});

describe("Schema validation against golden fixtures", () => {
  const validRankFiles = {
    rankedFiles: [
      { path: "packages/providers/src/ollama/ollama-provider.ts", relevanceScore: 0.95, reason: "Ollama provider" },
      { path: "packages/providers/src/provider.ts", relevanceScore: 0.8, reason: "Provider interface" },
    ],
    confidence: 0.84,
  };

  it("should accept well-formed rank-files output", () => {
    const result = RankRelevantFilesOutputSchema.safeParse(validRankFiles);
    expect(result.success).toBe(true);
  });

  it("should reject output with invalid relevance score (> 1)", () => {
    const invalid = {
      ...validRankFiles,
      rankedFiles: [{ path: "a.ts", relevanceScore: 1.5, reason: "test" }],
    };
    const result = RankRelevantFilesOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject output with missing required fields", () => {
    const invalid = {
      rankedFiles: [{ path: "a.ts" }], // missing relevanceScore and reason
      confidence: 0.5,
    };
    const result = RankRelevantFilesOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("should reject output with negative confidence", () => {
    const invalid = { ...validRankFiles, confidence: -0.5 };
    const result = RankRelevantFilesOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});