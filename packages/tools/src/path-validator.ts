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

/** True if a single path segment is sensitive. Matches the exact name AND dotted
 *  variants (.env → .env.local/.env.production; id_rsa → id_rsa.pub) so secrets
 *  aren't reachable just by appending a suffix (#262). */
export function isBlockedSegment(seg: string): boolean {
  return BLOCKED_PATTERNS.some((b) => seg === b || seg.startsWith(b + "."));
}

/** True if a path touches a sensitive (blocked) directory/file — for reads that
 *  aren't project-scoped (e.g. /image, @-mentions, /rag) (#239). */
export function isBlockedPath(p: string): boolean {
  return normalize(p).split(sep).some(isBlockedSegment);
}

export class PathValidator {
  readonly projectRoot: string;
  private readonly allowedRoots: string[];

  constructor(projectRoot: string, extraRoots: string[] = []) {
    this.projectRoot = resolve(projectRoot);
    this.allowedRoots = [this.projectRoot, ...extraRoots.map((r) => resolve(r))];
  }

  /**
   * Validates that a path is safe for filesystem operations.
   * Returns the resolved absolute path on success.
   * Throws only on blocked sensitive patterns (e.g. .ssh, .aws, .env).
   * Absolute paths and paths outside the project root are allowed — the AI
   * needs to be able to work on any directory the user points it at.
   */
  resolveSafePath(requestedPath: string): string {
    // Resolve to absolute; relative paths are resolved from projectRoot
    const absolute = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(join(this.projectRoot, requestedPath));

    const blocked = absolute.split(sep).find(isBlockedSegment);
    if (blocked) {
      throw new Error(
        `Access to blocked path denied: "${blocked}" detected in "${requestedPath}"`,
      );
    }

    return absolute;
  }

  /** Returns the path relative to the nearest allowed root. */
  toRelative(absolutePath: string): string {
    for (const root of this.allowedRoots) {
      const rel = relative(root, absolutePath);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
    }
    return relative(this.projectRoot, absolutePath);
  }

  isValidPath(requestedPath: string): boolean {
    try {
      this.resolveSafePath(requestedPath);
      return true;
    } catch {
      return false;
    }
  }

  fileExists(requestedPath: string): boolean {
    try {
      const safe = this.resolveSafePath(requestedPath);
      return existsSync(safe) && statSync(safe).isFile();
    } catch {
      return false;
    }
  }

  directoryExists(requestedPath: string): boolean {
    try {
      const safe = this.resolveSafePath(requestedPath);
      return existsSync(safe) && statSync(safe).isDirectory();
    } catch {
      return false;
    }
  }
}
