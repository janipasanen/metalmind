export { ToolRegistry, parseInput } from "./tool-registry.js";
export { PathValidator, BLOCKED_PATTERNS, isBlockedPath } from "./path-validator.js";
export { DiffGenerator } from "./ui/diff-generator.js";
export { AuditLog } from "./ui/audit-log.js";
export type { DiffPreview } from "./ui/diff-generator.js";
export type { ToolExecutionContext, ToolAuditEntry, AgentTool } from "./types.js";
export { createTool } from "./types.js";
export { allReadOnlyTools } from "./filesystem/readonly-tools.js";
export { allWriteTools, multiEditTool, replaceInProjectTool, deleteDirectoryTool } from "./filesystem/write-tools.js";
export {
  allDocumentTools,
  writeDocumentTool,
  createHtmlTool,
  createLatexTool,
  createMarkdownTool,
  createDocxTool,
  createOdtTool,
  createPptxTool,
  createOdpTool,
  createXlsxTool,
  createOdsTool,
  createCsvTool,
  buildXlsx,
  buildOds,
  buildHtmlDocument,
  buildLatexDocument,
  escapeHtml,
  escapeLatex,
  detectTexEngine,
  pandocPath,
  sofficePath,
  pandocTargetFor,
  runPandoc,
} from "./documents/index.js";
export { allWebTools, webFetchTool, webSearchTool } from "./web/web-tools.js";
export { allGitTools, gitStatusTool, gitDiffTool, gitDiffFileTool, gitAddTool, gitCommitTool } from "./git/git-tools.js";
export { runShellTools, runCommandTool, runTestsTool, runBuildTool, runLintTool, runFormatTool, runShellAsync } from "./shell/shell-tools.js";
export {
  backgroundShellTools,
  runBackgroundTool,
  pollBackgroundTool,
  stopBackgroundTool,
  killAllBackgroundProcesses,
  startBackgroundProcess,
  pollBackgroundProcess,
  stopBackgroundProcess,
  listBackgroundProcesses,
  _resetBackgroundRegistry,
} from "./shell/background-tools.js";
export { RepoMap } from "./context/repo-map.js";
export type { RepoMapEntry, RepoMapOptions } from "./context/repo-map.js";
export { parseSource, SymbolIndex } from "./code-intel/tree-sitter-parser.js";
export type { SymbolInfo, ImportInfo, ParseResult } from "./code-intel/tree-sitter-parser.js";
export {
  findSymbolTool,
  findReferencesTool,
  getCallGraphTool,
  allSymbolTools,
  getReferenceIndex,
  resetReferenceIndex,
  indexFile,
  setLspClient,
} from "./code-intel/symbol-tools.js";
export { createDiagnosticsTool } from "./code-intel/diagnostics-tool.js";
export { LspClient } from "./code-intel/lsp-client.js";
export type { LspDiagnostic, LspLocation } from "./code-intel/lsp-client.js";
export { ReferenceIndex } from "./code-intel/reference-index.js";
export type { ReferenceInfo } from "./code-intel/reference-index.js";
export { RepoMapV2 } from "./code-intel/repo-map-v2.js";
export type { EnhancedEntry, RepoMapV2Options } from "./code-intel/repo-map-v2.js";
