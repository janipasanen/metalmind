import { describe, it, expect } from "vitest";
import {
  ClassifyUserIntentInputSchema,
  ClassifyUserIntentOutputSchema,
  RankRelevantFilesInputSchema,
  RankRelevantFilesOutputSchema,
  SummarizeFileInputSchema,
  SummarizeFileOutputSchema,
  SummarizeDiffInputSchema,
  SummarizeDiffOutputSchema,
  SummarizeCommandOutputInputSchema,
  SummarizeCommandOutputOutputSchema,
  ExtractSymbolsInputSchema,
  ExtractSymbolsOutputSchema,
  ExtractImportsInputSchema,
  ExtractImportsOutputSchema,
  IdentifyLikelyTestFilesInputSchema,
  IdentifyLikelyTestFilesOutputSchema,
  GenerateCommitMessageInputSchema,
  GenerateCommitMessageOutputSchema,
  ValidateJsonLikeOutputInputSchema,
  ValidateJsonLikeOutputOutputSchema,
  SuggestSimpleEditInputSchema,
  SuggestSimpleEditOutputSchema,
  ExplainCompilerErrorInputSchema,
  ExplainCompilerErrorOutputSchema,
  LOCAL_WORKER_TASK_SCHEMAS,
} from "@metalmind/schemas";

describe("ClassifyUserIntent schemas", () => {
  const validInput = { userMessage: "Add a button to the homepage" };
  const validOutput = {
    intent: "code_change",
    confidence: 0.9,
    suggestedTier: "local-worker",
    reason: "Simple UI change",
  };

  it("should validate valid input", () => {
    expect(ClassifyUserIntentInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("should validate valid output", () => {
    expect(ClassifyUserIntentOutputSchema.safeParse(validOutput).success).toBe(true);
  });

  it("should reject empty userMessage", () => {
    expect(ClassifyUserIntentInputSchema.safeParse({ userMessage: "" }).success).toBe(false);
  });

  it("should coerce an invalid intent to 'other' (local models hallucinate)", () => {
    const result = ClassifyUserIntentOutputSchema.safeParse({ ...validOutput, intent: "invalid" });
    expect(result.success).toBe(true);
    expect(result.data?.intent).toBe("other");
  });

  it("should accept greeting intent", () => {
    expect(ClassifyUserIntentOutputSchema.safeParse({
      ...validOutput,
      intent: "greeting",
      reason: "User is saying hello",
    }).success).toBe(true);
  });

  it("should coerce out-of-range confidence to the 0.5 fallback", () => {
    const high = ClassifyUserIntentOutputSchema.safeParse({ ...validOutput, confidence: 1.5 });
    expect(high.success).toBe(true);
    expect(high.data?.confidence).toBe(0.5);

    const low = ClassifyUserIntentOutputSchema.safeParse({ ...validOutput, confidence: -0.1 });
    expect(low.success).toBe(true);
    expect(low.data?.confidence).toBe(0.5);
  });
});

describe("RankRelevantFiles schemas", () => {
  const validInput = {
    userGoal: "Add Ollama Cloud provider",
    candidateFiles: ["a.ts", "b.ts"],
  };
  const validOutput = {
    rankedFiles: [
      { path: "a.ts", relevanceScore: 0.95, reason: "Contains provider logic" },
    ],
    confidence: 0.84,
  };

  it("should validate valid input", () => {
    expect(RankRelevantFilesInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("should validate valid output", () => {
    expect(RankRelevantFilesOutputSchema.safeParse(validOutput).success).toBe(true);
  });

  it("should reject empty candidateFiles", () => {
    expect(RankRelevantFilesInputSchema.safeParse({ ...validInput, candidateFiles: [] }).success).toBe(false);
  });

  it("should reject too many candidateFiles", () => {
    const tooMany = { ...validInput, candidateFiles: Array(51).fill("file.ts") };
    expect(RankRelevantFilesInputSchema.safeParse(tooMany).success).toBe(false);
  });

  it("should reject relevanceScore > 1", () => {
    expect(RankRelevantFilesOutputSchema.safeParse({
      ...validOutput,
      rankedFiles: [{ path: "a.ts", relevanceScore: 1.5, reason: "test" }],
    }).success).toBe(false);
  });

  it("should reject relevanceScore < 0", () => {
    expect(RankRelevantFilesOutputSchema.safeParse({
      ...validOutput,
      rankedFiles: [{ path: "a.ts", relevanceScore: -0.1, reason: "test" }],
    }).success).toBe(false);
  });
});

describe("SummarizeFile schemas", () => {
  it("should validate valid input", () => {
    expect(SummarizeFileInputSchema.safeParse({
      filePath: "src/index.ts",
      fileContent: "export const x = 1;",
      maxSummaryTokens: 500,
    }).success).toBe(true);
  });

  it("should validate valid output", () => {
    expect(SummarizeFileOutputSchema.safeParse({
      summary: "Exports a constant x",
      symbols: ["x"],
      language: "typescript",
      lineCount: 1,
      confidence: 0.9,
    }).success).toBe(true);
  });

  it("should reject missing fileContent", () => {
    expect(SummarizeFileInputSchema.safeParse({ filePath: "a.ts" }).success).toBe(false);
  });
});

describe("SummarizeDiff schemas", () => {
  it("should validate valid diff summary", () => {
    expect(SummarizeDiffOutputSchema.safeParse({
      summary: "Added new function",
      changeType: "addition",
      affectedAreas: ["src/api"],
      confidence: 0.85,
    }).success).toBe(true);
  });

  it("should reject invalid changeType", () => {
    expect(SummarizeDiffOutputSchema.safeParse({
      summary: "test",
      changeType: "invalid",
      confidence: 0.85,
    }).success).toBe(false);
  });
});

describe("SummarizeCommandOutput schemas", () => {
  it("should validate valid output", () => {
    expect(SummarizeCommandOutputOutputSchema.safeParse({
      summary: "Tests passed",
      success: true,
      keyPoints: ["All 42 tests passed"],
      errors: [],
      confidence: 0.95,
    }).success).toBe(true);
  });
});

describe("ExtractSymbols schemas", () => {
  it("should validate valid symbols", () => {
    expect(ExtractSymbolsOutputSchema.safeParse({
      symbols: [
        { name: "MyClass", kind: "class", line: 10, export: true },
        { name: "helper", kind: "function", line: 25 },
      ],
      confidence: 0.88,
    }).success).toBe(true);
  });

  it("should reject invalid symbol kind", () => {
    expect(ExtractSymbolsOutputSchema.safeParse({
      symbols: [{ name: "x", kind: "invalid" }],
      confidence: 0.5,
    }).success).toBe(false);
  });
});

describe("ExtractImports schemas", () => {
  it("should validate valid imports", () => {
    expect(ExtractImportsOutputSchema.safeParse({
      imports: [
        { module: "react", items: ["useState", "useEffect"], isTypeOnly: false },
        { module: "zod", items: ["z"], isTypeOnly: true },
      ],
      confidence: 0.9,
    }).success).toBe(true);
  });
});

describe("IdentifyLikelyTestFiles schemas", () => {
  it("should validate valid test file identification", () => {
    expect(IdentifyLikelyTestFilesOutputSchema.safeParse({
      testFiles: [
        { path: "src/index.test.ts", relevanceScore: 0.9, reason: "Named test file" },
      ],
      confidence: 0.85,
    }).success).toBe(true);
  });
});

describe("GenerateCommitMessage schemas", () => {
  it("should validate valid commit message output", () => {
    expect(GenerateCommitMessageOutputSchema.safeParse({
      message: "feat: add Ollama cloud provider",
      body: "Extended OllamaProvider to support cloud models",
      confidence: 0.8,
    }).success).toBe(true);
  });
});

describe("ValidateJsonLikeOutput schemas", () => {
  it("should validate valid JSON detection", () => {
    expect(ValidateJsonLikeOutputOutputSchema.safeParse({
      isValid: true,
      parsed: { key: "value" },
      confidence: 0.95,
    }).success).toBe(true);
  });

  it("should validate invalid JSON detection", () => {
    expect(ValidateJsonLikeOutputOutputSchema.safeParse({
      isValid: false,
      errors: ["Unexpected token at position 5"],
      confidence: 0.9,
    }).success).toBe(true);
  });
});

describe("SuggestSimpleEdit schemas", () => {
  it("should validate valid edit suggestion", () => {
    expect(SuggestSimpleEditOutputSchema.safeParse({
      oldText: "const x = 1;",
      newText: "const x = 2;",
      description: "Change x from 1 to 2",
      confidence: 0.75,
    }).success).toBe(true);
  });
});

describe("ExplainCompilerError schemas", () => {
  it("should validate valid error explanation", () => {
    expect(ExplainCompilerErrorOutputSchema.safeParse({
      explanation: "Type mismatch: string is not assignable to number",
      likelyFix: "Change the type annotation to string or cast the value",
      severity: "error",
      confidence: 0.85,
    }).success).toBe(true);
  });
});

describe("LOCAL_WORKER_TASK_SCHEMAS completeness", () => {
  it("should have schemas for all defined task types", () => {
    const expectedTaskTypes = [
      "classifyUserIntent",
      "rankRelevantFiles",
      "summarizeFile",
      "summarizeDiff",
      "summarizeCommandOutput",
      "extractSymbols",
      "extractImports",
      "identifyLikelyTestFiles",
      "generateCommitMessageDraft",
      "validateJsonLikeOutput",
      "suggestSimpleEdit",
      "explainCompilerError",
    ];
    for (const taskType of expectedTaskTypes) {
      expect(LOCAL_WORKER_TASK_SCHEMAS).toHaveProperty(taskType);
      expect(LOCAL_WORKER_TASK_SCHEMAS[taskType]).toHaveProperty("input");
      expect(LOCAL_WORKER_TASK_SCHEMAS[taskType]).toHaveProperty("output");
    }
  });
});