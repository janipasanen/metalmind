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

const SECRET_FILE_PATTERNS = [
  /\.env$/,
  /\.env\./,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa$/,
  /id_ed25519$/,
  /id_ecdsa$/,
  /\.ssh\//,
  /\.aws\//,
  /\.kube\//,
  /\.gnupg\//,
  /\.git-credentials$/,
  /\.npmrc$/,
  /credentials\.json$/,
  /service-account.*\.json$/,
];

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
      "createFile",
      "deleteFile",
      "moveFile",
      "gitCommit",
      "gitAdd",
      "gitRestore",
      "gitCreateBranch",
      "runCommand",
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