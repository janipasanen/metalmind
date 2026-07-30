import type { AgentTool, ToolExecutionContext } from "@metalmind/tools";

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-\w*r\w*f\s+|-[aAa-zZ]*r[aA-zZ]*f)/,
  /\bsudo\b/,
  /\bcurl\s+.*\|\s*(sh|bash|zsh)/,
  /\bwget\s+.*\|\s*(sh|bash|zsh)/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fd\b/,
  /\bdocker\s+system\s+prune\b/,
  /\bsecurity\s+dump-keychain\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\b:()\s*\{\s*:\s*\|\s*:&\s*\}/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]/,
];

// Case-insensitive (#359): macOS filesystems are case-insensitive by default,
// so ".SSH/id_rsa" and ".Env" open the same files as their lowercase forms.
const SECRET_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\./i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa$/i,
  /id_ed25519$/i,
  /id_ecdsa$/i,
  /\.ssh\//i,
  /\.aws\//i,
  /\.kube\//i,
  /\.gnupg\//i,
  /\.git-credentials$/i,
  /\.npmrc$/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
];

/** Shell substitution/metacharacters that have no business in a *file path*
 *  argument that will be interpolated into a shell command line (#358). */
const SHELL_SUBSTITUTION = /(\$\(|`|\$\{|\|\||&&|;|\n)/;

export interface SafetyViolation {
  type: "forbidden_command" | "forbidden_file" | "local_worker_tool_call" | "path_traversal" | "secret_in_context";
  message: string;
  severity: "error" | "warning";
  details?: unknown;
}

export class SafetyValidator {
  private projectRoot: string;
  private allowedPaths: string[];

  constructor(projectRoot: string, extraPaths: string[] = []) {
    this.projectRoot = projectRoot;
    this.allowedPaths = [projectRoot, ...extraPaths];
  }

  validateShellCommand(command: string): SafetyViolation | null {
    // Robust recursive-force `rm` detection: catches -rf, -fr, -r -f, -f -r,
    // -Rf, --recursive --force in any order/spacing (the regex list below only
    // catches a subset). Triggers only when BOTH recursive and force are set.
    if (this.isRecursiveForceRm(command)) {
      return {
        type: "forbidden_command",
        message: `Dangerous command blocked: "${command}" (recursive force delete)`,
        severity: "error",
        details: { command, pattern: "rm -rf (any order)" },
      };
    }
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return {
          type: "forbidden_command",
          message: `Dangerous command blocked: "${command}" matches pattern "${pattern.source}"`,
          severity: "error",
          details: { command, pattern: pattern.source },
        };
      }
    }
    return null;
  }

  /** True if the command invokes `rm` with both recursive and force flags, in any order. */
  private isRecursiveForceRm(command: string): boolean {
    // Inspect each `rm` invocation up to a command separator.
    const re = /\brm\b([^;&|\n]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      const args = m[1];
      const flagLetters = (args.match(/-[a-zA-Z]+/g) ?? []).join("");
      const recursive = /r/i.test(flagLetters) || /--recursive\b/.test(args);
      const force = /f/i.test(flagLetters) || /--force\b/.test(args);
      if (recursive && force) return true;
    }
    return false;
  }

  /** A path argument destined for a shell command line must be a plain path:
   *  reject command substitution and command chaining outright (#358). */
  validateShellArgument(value: string): SafetyViolation | null {
    if (SHELL_SUBSTITUTION.test(value)) {
      return {
        type: "forbidden_command",
        message: `Shell metacharacters are not allowed in a path argument: "${value}"`,
        severity: "error",
        details: { value },
      };
    }
    return null;
  }

  validateFilePath(path: string): SafetyViolation | null {
    for (const pattern of SECRET_FILE_PATTERNS) {
      if (pattern.test(path)) {
        return {
          type: "secret_in_context",
          message: `Secret file detected in path: "${path}"`,
          severity: "warning",
          details: { path, pattern: pattern.source },
        };
      }
    }

    const normalized = path.replace(/\.\./g, "").replace(/\/\//g, "/");
    if (normalized !== path && path.includes("..")) {
      return {
        type: "path_traversal",
        message: `Path traversal detected: "${path}"`,
        severity: "error",
        details: { path },
      };
    }

    return null;
  }

  validateLocalWorkerOutput(output: unknown): SafetyViolation[] {
    const violations: SafetyViolation[] = [];

    if (typeof output === "string") {
      const cmdViolation = this.validateShellCommand(output);
      if (cmdViolation) violations.push(cmdViolation);
    }

    if (typeof output === "object" && output !== null) {
      const obj = output as Record<string, unknown>;
      if (obj.toolName || obj.toolCallId || obj.argumentsJson) {
        violations.push({
          type: "local_worker_tool_call",
          message: "Local worker attempted to request a tool call — this is forbidden",
          severity: "error",
          details: output,
        });
      }

      const suggestion = obj as Record<string, unknown>;
      if (typeof suggestion.oldText === "string" && typeof suggestion.newText === "string") {
        if (suggestion.newText.includes("rm -rf") || suggestion.newText.includes("sudo")) {
          violations.push({
            type: "forbidden_command",
            message: "Local worker suggested edit contains dangerous command",
            severity: "warning",
            details: { path: suggestion.filePath },
          });
        }
      }
    }

    return violations;
  }

  requiresApproval(toolName: string): boolean {
    const APPROVAL_REQUIRED_TOOLS = new Set([
      "writeFile",
      "editFile",
      "multiEdit",
      "replaceInProject",
      "createFile",
      "deleteFile",
      "moveFile",
      "createDirectory",
      "deleteDirectory",
      "gitCommit",
      "gitAdd",
      "gitRestore",
      "gitCreateBranch",
      "gitPush",
      "createPullRequest",
      "runCommand",
      "runBackground",
      // These accept a model-overridable `command`, so they must be gated and
      // command-validated just like runCommand (#252).
      "runTests",
      "runBuild",
      "runLint",
      "runFormat",
      // Document/spreadsheet writers take an arbitrary `path` and overwrite
      // whatever is there — including source files. They were missing from this
      // set, so they wrote with no prompt, no diff and no safety net (#376).
      "writeDocument",
      "createHtml",
      "createLatex",
      "createMarkdown",
      "createDocx",
      "createOdt",
      "createPptx",
      "createOdp",
      "createXlsx",
      "createOds",
      "createCsv",
    ]);
    return APPROVAL_REQUIRED_TOOLS.has(toolName);
  }

  isToolAllowedForAgent(toolName: string, agentRole: "local-worker" | "cloud-main"): boolean {
    if (agentRole === "local-worker") {
      return false;
    }
    return true;
  }
}