import { resolve, relative, sep, isAbsolute, join, normalize } from "node:path";
import { statSync, existsSync } from "node:fs";

export const BLOCKED_PATTERNS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".env",
  ".git-credentials",
  ".npmrc",
  "id_rsa",
  "id_ed25519",
  "authorized_keys",
];

export class PathValidator {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  /**
   * Validates that a path is safe for filesystem operations.
   * Returns the resolved absolute path on success.
   * Throws on path traversal, blocked paths, or paths outside root.
   */
  resolveSafePath(requestedPath: string): string {
    const normalized = normalize(requestedPath);
    const absolute = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(join(this.projectRoot, normalized));

    const rel = relative(this.projectRoot, absolute);

    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Path traversal blocked: "${requestedPath}" is outside project root`,
      );
    }

    const parts = absolute.split(sep);
    for (const blocked of BLOCKED_PATTERNS) {
      if (parts.includes(blocked)) {
        throw new Error(
          `Access to blocked path denied: "${blocked}" detected in "${requestedPath}"`,
        );
      }
    }

    return absolute;
  }

  /**
   * Returns the path relative to project root for display purposes.
   */
  toRelative(absolutePath: string): string {
    return relative(this.projectRoot, absolutePath);
  }

  /**
   * Checks if a path exists and is within project root.
   */
  isValidPath(requestedPath: string): boolean {
    try {
      this.resolveSafePath(requestedPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if a file exists and returns its stats if so.
   */
  fileExists(requestedPath: string): boolean {
    try {
      const safe = this.resolveSafePath(requestedPath);
      return existsSync(safe) && statSync(safe).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Checks if a directory exists and returns true if so.
   */
  directoryExists(requestedPath: string): boolean {
    try {
      const safe = this.resolveSafePath(requestedPath);
      return existsSync(safe) && statSync(safe).isDirectory();
    } catch {
      return false;
    }
  }
}
