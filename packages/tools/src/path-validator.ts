import { resolve, relative, sep, isAbsolute, join, normalize } from "node:path";
import { statSync, existsSync, realpathSync } from "node:fs";

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
 *  aren't reachable just by appending a suffix (#262).
 *
 *  Case-INSENSITIVE (#359): macOS APFS/HFS+ are case-insensitive by default, so
 *  `.SSH/id_rsa` and `.Env` open exactly the same files as their lowercase
 *  forms. A case-sensitive comparison let a model (or injected instruction)
 *  read secrets straight past this gate just by changing capitalization. */
export function isBlockedSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  return BLOCKED_PATTERNS.some((b) => s === b || s.startsWith(b + "."));
}

/** True if a path touches a sensitive (blocked) directory/file — for reads that
 *  aren't project-scoped (e.g. /image, @-mentions, /rag) (#239).
 *
 *  Symlinks are resolved first where possible (#359): `resolve()` is purely
 *  lexical, so a link like ./keys → ~/.ssh would otherwise slip through. */
export function isBlockedPath(p: string): boolean {
  const candidates = [normalize(p)];
  try {
    const real = realpathSync(p);
    if (real !== candidates[0]) candidates.push(real);
  } catch {
    // Path doesn't exist yet (a write target) — the lexical check still applies.
  }
  return candidates.some((c) => c.split(sep).some(isBlockedSegment));
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

    // Check the lexical path AND, when it exists, its symlink-resolved target:
    // ./keys → ~/.ssh must not become a hole in the blocklist (#359).
    let blocked = absolute.split(sep).find(isBlockedSegment);
    if (!blocked) {
      try {
        const real = realpathSync(absolute);
        if (real !== absolute) blocked = real.split(sep).find(isBlockedSegment);
      } catch {
        // Doesn't exist yet — the lexical check above is the whole gate.
      }
    }
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
