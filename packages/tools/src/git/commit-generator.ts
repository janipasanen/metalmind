/**
 * Commit message generation from git diffs.
 * Creates conventional commit messages with type, scope, and description.
 */
import { execSync } from "node:child_process";

export interface CommitSuggestion {
  type: string;
  scope?: string;
  description: string;
  fullMessage: string;
}

export class CommitMessageGenerator {
  /**
   * Analyze a git diff and generate a conventional commit message.
   */
  static generateFromDiff(diff: string): CommitSuggestion {
    const filesChanged = this.extractFiles(diff);
    const type = this.detectType(diff);
    const scope = this.detectScope(filesChanged);
    const description = this.summarizeChanges(diff);

    const fullMessage = scope
      ? `${type}(${scope}): ${description}`
      : `${type}: ${description}`;

    return { type, scope, fullMessage, description };
  }

  /**
   * Generate message from current staged changes.
   */
  static generateFromRepo(cwd: string): CommitSuggestion {
    try {
      const staged = execSync("git diff --staged --unified=3", {
        cwd,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 5 * 1024 * 1024,
      }).trim();

      if (!staged) {
        return {
          type: "chore",
          description: "empty commit",
          fullMessage: "chore: empty commit",
        };
      }

      return this.generateFromDiff(staged);
    } catch {
      return {
        type: "chore",
        description: "changes",
        fullMessage: "chore: changes",
      };
    }
  }

  private static extractFiles(diff: string): string[] {
    const files: string[] = [];
    const match = diff.matchAll(/^\+\+\+ b\/(.+)$/gm);
    for (const m of match) {
      files.push(m[1]);
    }
    return files;
  }

  private static detectType(diff: string): string {
    if (diff.includes("test(") || diff.match(/\.test\./)) return "test";
    if (diff.match(/fix(ed|es)?|bug/i)) return "fix";
    if (diff.includes("refactor")) return "refactor";
    if (diff.match(/README|\.md$/m)) return "docs";
    if (diff.match(/package\.json|lock/i)) return "build";
    if (/^\+/m.test(diff)) return "feat";
    return "chore";
  }

  private static detectScope(files: string[]): string | undefined {
    if (files.length === 0) return undefined;
    if (files.length === 1) {
      const parts = files[0].split("/");
      if (parts.length > 1) return parts[0];
    }
    const dirs = files.map((f) => f.split("/")[0]);
    const unique = [...new Set(dirs)];
    if (unique.length === 1) return unique[0];
    return undefined;
  }

  private static summarizeChanges(diff: string): string {
    const fileCount = (diff.match(/\+\+\+ b\//g) ?? []).length;
    const additions = (diff.match(/^\+[^+]/gm) ?? []).length;
    const deletions = (diff.match(/^-[^-]/gm) ?? []).length;

    if (fileCount === 0) return "update";
    if (fileCount === 1) {
      const files = this.extractFiles(diff);
      const verb = additions > 0 && deletions > 0 ? "update" : additions > 0 ? "add" : "remove";
      return `${verb} ${files[0]?.split("/").pop() ?? "file"}`;
    }
    return `${+additions}/-${deletions} across ${fileCount} files`;
  }
}
