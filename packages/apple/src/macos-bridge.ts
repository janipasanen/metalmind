import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HelperResponse {
  success: boolean;
  data: string | null;
  error: string | null;
}

/**
 * Finds the MacOSHelper binary path.
 */
function findHelperBinary(): string | null {
  // Check common locations
  const candidates = [
    // Built via Swift Package Manager (debug)
    resolve(
      __dirname,
      "../../../apps/macos-helper/.build/debug/MacOSHelper",
    ),
    // Built via Swift Package Manager (release)
    resolve(
      __dirname,
      "../../../apps/macos-helper/.build/release/MacOSHelper",
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Runs the Swift helper with given arguments and returns parsed response.
 */
async function runHelper(
  args: string[],
): Promise<HelperResponse> {
  const binary = findHelperBinary();
  if (!binary) {
    return {
      success: false,
      data: null,
      error:
        "MacOSHelper binary not found. Build it with: cd apps/macos-helper && swift build",
    };
  }

  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: 10_000,
    });
    return JSON.parse(stdout.trim()) as HelperResponse;
  } catch (err) {
    const execErr = err as ExecFileException;
    return {
      success: false,
      data: null,
      error: execErr.message || String(err),
    };
  }
}

/**
 * Keychain operations via Swift helper.
 */
export const keychain = {
  async get(account: string): Promise<string | null> {
    const resp = await runHelper(["keychain-get", account]);
    if (resp.success && resp.data) return resp.data;
    return null;
  },

  async set(account: string, value: string): Promise<boolean> {
    const resp = await runHelper(["keychain-set", account, value]);
    return resp.success;
  },

  async delete(account: string): Promise<boolean> {
    const resp = await runHelper(["keychain-delete", account]);
    return resp.success;
  },

  async list(): Promise<string[]> {
    const resp = await runHelper(["keychain-list"]);
    if (resp.success && resp.data) {
      return resp.data.split("\n").filter(Boolean);
    }
    return [];
  },
};

/**
 * Native macOS notifications via Swift helper.
 */
export const notifications = {
  async send(title: string, body: string): Promise<boolean> {
    const resp = await runHelper(["notify", title, body]);
    return resp.success;
  },
};

/**
 * Spotlight indexing via Swift helper.
 */
export const spotlight = {
  async index(path: string, name: string): Promise<boolean> {
    const resp = await runHelper(["spotlight-index", path, name]);
    return resp.success;
  },
};

/**
 * Check if the Swift helper is available.
 */
export async function isHelperAvailable(): Promise<boolean> {
  const binary = findHelperBinary();
  if (!binary) return false;

  try {
    const resp = await runHelper(["keychain-list"]);
    return resp.success;
  } catch {
    return false;
  }
}
