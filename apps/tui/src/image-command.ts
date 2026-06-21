import { readFileSync, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { isBlockedPath } from "@metalmind/tools";

/**
 * `/image <path>` support (#177): read a local image file and turn it into a
 * base64 data URL that the agent can stage for the next user turn. Remote https
 * image URLs are passed through unchanged.
 */

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Max inline image size (~5 MB) — base64 inflates ~33%, keep payloads sane. */
const MAX_BYTES = 5 * 1024 * 1024;

export interface ImageResult {
  url?: string;
  error?: string;
}

export function buildImageUrl(pathOrUrl: string): ImageResult {
  const input = pathOrUrl.trim();
  if (!input) return { error: "Usage: /image <path-or-https-url>" };
  if (/^https?:\/\//i.test(input)) return { url: input };

  if (isBlockedPath(input)) return { error: `Refusing to read a sensitive path: ${input}` };
  if (!existsSync(input)) return { error: `Image not found: ${input}` };
  const ext = extname(input).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return { error: `Unsupported image type "${ext}". Use png/jpg/gif/webp.` };
  const size = statSync(input).size;
  if (size > MAX_BYTES) return { error: `Image too large (${(size / 1024 / 1024).toFixed(1)} MB; max 5 MB).` };

  const base64 = readFileSync(input).toString("base64");
  return { url: `data:${mime};base64,${base64}` };
}
