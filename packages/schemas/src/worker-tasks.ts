import { z } from "zod";

export const ClassifyUserIntentInputSchema = z.object({
  userMessage: z.string().min(1).max(2000),
  conversationContext: z.string().max(5000).optional(),
});

export const ClassifyUserIntentOutputSchema = z.object({
  intent: z
    .enum([
      "question",
      "code_change",
      "debug",
      "explain",
      "search",
      "refactor",
      "test",
      "deploy",
      "greeting",
      "other",
    ])
    .catch("other"), // local models sometimes hallucinate; default to "other"
  confidence: z.number().min(0).max(1).catch(0.5),
  suggestedTier: z
    .enum(["local-worker", "cloud-main", "direct-tool"])
    .catch("cloud-main"), // unexpected values → escalate to cloud safely
  reason: z.string().min(1).catch("unspecified"),
});
export type ClassifyUserIntentInput = z.infer<typeof ClassifyUserIntentInputSchema>;
export type ClassifyUserIntentOutput = z.infer<typeof ClassifyUserIntentOutputSchema>;

export const RankRelevantFilesInputSchema = z.object({
  userGoal: z.string().min(1).max(2000),
  candidateFiles: z.array(z.string()).min(1).max(50),
});

export const RankRelevantFilesOutputSchema = z.object({
  rankedFiles: z.array(
    z.object({
      path: z.string().min(1),
      relevanceScore: z.number().min(0).max(1),
      reason: z.string().min(1),
    }),
  ),
  confidence: z.number().min(0).max(1),
});
export type RankRelevantFilesInput = z.infer<typeof RankRelevantFilesInputSchema>;
export type RankRelevantFilesOutput = z.infer<typeof RankRelevantFilesOutputSchema>;

export const SummarizeFileInputSchema = z.object({
  filePath: z.string().min(1),
  fileContent: z.string().max(30000),
  maxSummaryTokens: z.number().int().positive().default(500),
});

export const SummarizeFileOutputSchema = z.object({
  summary: z.string().min(1),
  symbols: z.array(z.string()).optional(),
  language: z.string().optional(),
  lineCount: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1),
});
export type SummarizeFileInput = z.infer<typeof SummarizeFileInputSchema>;
export type SummarizeFileOutput = z.infer<typeof SummarizeFileOutputSchema>;

export const SummarizeDiffInputSchema = z.object({
  diff: z.string().min(1).max(50000),
  filePath: z.string().optional(),
});

export const SummarizeDiffOutputSchema = z.object({
  summary: z.string().min(1),
  changeType: z.enum(["addition", "modification", "deletion", "mixed"]).optional(),
  affectedAreas: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});
export type SummarizeDiffInput = z.infer<typeof SummarizeDiffInputSchema>;
export type SummarizeDiffOutput = z.infer<typeof SummarizeDiffOutputSchema>;

export const SummarizeCommandOutputInputSchema = z.object({
  command: z.string().min(1),
  output: z.string().max(50000),
  exitCode: z.number().int().optional(),
});

export const SummarizeCommandOutputOutputSchema = z.object({
  summary: z.string().min(1),
  success: z.boolean(),
  keyPoints: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});
export type SummarizeCommandOutputInput = z.infer<typeof SummarizeCommandOutputInputSchema>;
export type SummarizeCommandOutputOutput = z.infer<typeof SummarizeCommandOutputOutputSchema>;

export const ExtractSymbolsInputSchema = z.object({
  fileContent: z.string().min(1).max(30000),
  filePath: z.string().min(1).optional(),
});

export const ExtractSymbolsOutputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.enum([
        "function",
        "class",
        "interface",
        "type",
        "variable",
        "constant",
        "enum",
        "method",
        "property",
        "namespace",
        "other",
      ]),
      line: z.number().int().nonnegative().optional(),
      export: z.boolean().optional(),
    }),
  ),
  confidence: z.number().min(0).max(1),
});
export type ExtractSymbolsInput = z.infer<typeof ExtractSymbolsInputSchema>;
export type ExtractSymbolsOutput = z.infer<typeof ExtractSymbolsOutputSchema>;

export const ExtractImportsInputSchema = z.object({
  fileContent: z.string().min(1).max(30000),
  filePath: z.string().min(1).optional(),
});

export const ExtractImportsOutputSchema = z.object({
  imports: z.array(
    z.object({
      module: z.string().min(1),
      items: z.array(z.string()).optional(),
      isTypeOnly: z.boolean().optional(),
    }),
  ),
  confidence: z.number().min(0).max(1),
});
export type ExtractImportsInput = z.infer<typeof ExtractImportsInputSchema>;
export type ExtractImportsOutput = z.infer<typeof ExtractImportsOutputSchema>;

export const IdentifyLikelyTestFilesInputSchema = z.object({
  sourceFilePath: z.string().min(1),
  projectFileList: z.array(z.string()).min(1).max(200),
});

export const IdentifyLikelyTestFilesOutputSchema = z.object({
  testFiles: z.array(
    z.object({
      path: z.string().min(1),
      relevanceScore: z.number().min(0).max(1),
      reason: z.string().min(1),
    }),
  ),
  confidence: z.number().min(0).max(1),
});
export type IdentifyLikelyTestFilesInput = z.infer<typeof IdentifyLikelyTestFilesInputSchema>;
export type IdentifyLikelyTestFilesOutput = z.infer<typeof IdentifyLikelyTestFilesOutputSchema>;

export const GenerateCommitMessageInputSchema = z.object({
  diff: z.string().min(1).max(50000),
  changedFiles: z.array(z.string()).min(1).max(100),
});

export const GenerateCommitMessageOutputSchema = z.object({
  message: z.string().min(1),
  body: z.string().optional(),
  confidence: z.number().min(0).max(1),
});
export type GenerateCommitMessageInput = z.infer<typeof GenerateCommitMessageInputSchema>;
export type GenerateCommitMessageOutput = z.infer<typeof GenerateCommitMessageOutputSchema>;

export const ValidateJsonLikeOutputInputSchema = z.object({
  rawOutput: z.string().min(1).max(10000),
  expectedSchemaType: z.string().min(1),
});

export const ValidateJsonLikeOutputOutputSchema = z.object({
  isValid: z.boolean(),
  parsed: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});
export type ValidateJsonLikeOutputInput = z.infer<typeof ValidateJsonLikeOutputInputSchema>;
export type ValidateJsonLikeOutputOutput = z.infer<typeof ValidateJsonLikeOutputOutputSchema>;

export const SuggestSimpleEditInputSchema = z.object({
  fileContent: z.string().min(1).max(30000),
  instruction: z.string().min(1).max(2000),
  filePath: z.string().optional(),
});

export const SuggestSimpleEditOutputSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string().min(1),
  description: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type SuggestSimpleEditInput = z.infer<typeof SuggestSimpleEditInputSchema>;
export type SuggestSimpleEditOutput = z.infer<typeof SuggestSimpleEditOutputSchema>;

export const ExplainCompilerErrorInputSchema = z.object({
  errorOutput: z.string().min(1).max(10000),
  language: z.string().optional(),
  filePath: z.string().optional(),
});

export const ExplainCompilerErrorOutputSchema = z.object({
  explanation: z.string().min(1),
  likelyFix: z.string().optional(),
  severity: z.enum(["error", "warning", "info"]).optional(),
  confidence: z.number().min(0).max(1),
});
export type ExplainCompilerErrorInput = z.infer<typeof ExplainCompilerErrorInputSchema>;
export type ExplainCompilerErrorOutput = z.infer<typeof ExplainCompilerErrorOutputSchema>;

export const LOCAL_WORKER_TASK_SCHEMAS: Record<
  string,
  { input: z.ZodTypeAny; output: z.ZodTypeAny }
> = {
  classifyUserIntent: {
    input: ClassifyUserIntentInputSchema,
    output: ClassifyUserIntentOutputSchema,
  },
  rankRelevantFiles: {
    input: RankRelevantFilesInputSchema,
    output: RankRelevantFilesOutputSchema,
  },
  summarizeFile: {
    input: SummarizeFileInputSchema,
    output: SummarizeFileOutputSchema,
  },
  summarizeDiff: {
    input: SummarizeDiffInputSchema,
    output: SummarizeDiffOutputSchema,
  },
  summarizeCommandOutput: {
    input: SummarizeCommandOutputInputSchema,
    output: SummarizeCommandOutputOutputSchema,
  },
  extractSymbols: {
    input: ExtractSymbolsInputSchema,
    output: ExtractSymbolsOutputSchema,
  },
  extractImports: {
    input: ExtractImportsInputSchema,
    output: ExtractImportsOutputSchema,
  },
  identifyLikelyTestFiles: {
    input: IdentifyLikelyTestFilesInputSchema,
    output: IdentifyLikelyTestFilesOutputSchema,
  },
  generateCommitMessageDraft: {
    input: GenerateCommitMessageInputSchema,
    output: GenerateCommitMessageOutputSchema,
  },
  validateJsonLikeOutput: {
    input: ValidateJsonLikeOutputInputSchema,
    output: ValidateJsonLikeOutputOutputSchema,
  },
  suggestSimpleEdit: {
    input: SuggestSimpleEditInputSchema,
    output: SuggestSimpleEditOutputSchema,
  },
  explainCompilerError: {
    input: ExplainCompilerErrorInputSchema,
    output: ExplainCompilerErrorOutputSchema,
  },
};