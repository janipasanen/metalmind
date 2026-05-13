import { keychain } from "./macos-bridge.js";

export interface ApiKeyEntry {
  provider: string;
  account: string;
  key: string;
}

/**
 * Keychain-backed API key storage.
 * Falls back to environment variables when helper is unavailable.
 */
export class KeychainConfig {
  private cache = new Map<string, string>();

  /**
   * Load an API key — tries Keychain first, then env vars.
   */
  async getKey(provider: string): Promise<string | null> {
    // Check cache
    if (this.cache.has(provider)) {
      return this.cache.get(provider) ?? null;
    }

    // Try Keychain
    try {
      const key = await keychain.get(`metalmind:${provider}`);
      if (key) {
        this.cache.set(provider, key);
        return key;
      }
    } catch {
      // Keychain unavailable — fall through
    }

    // Fallback: environment variable
    const envKey = process.env[`METALMIND_${provider.toUpperCase()}_API_KEY`];
    if (envKey) {
      this.cache.set(provider, envKey);
      return envKey;
    }

    return null;
  }

  /**
   * Store an API key in Keychain.
   */
  async setKey(provider: string, key: string): Promise<boolean> {
    const ok = await keychain.set(`metalmind:${provider}`, key);
    if (ok) {
      this.cache.set(provider, key);
    }
    return ok;
  }

  /**
   * Delete an API key from Keychain.
   */
  async deleteKey(provider: string): Promise<boolean> {
    const ok = await keychain.delete(`metalmind:${provider}`);
    if (ok) {
      this.cache.delete(provider);
    }
    return ok;
  }

  /**
   * List all stored API key providers.
   */
  async listProviders(): Promise<string[]> {
    try {
      const accounts = await keychain.list();
      return accounts
        .filter((a) => a.startsWith("metalmind:"))
        .map((a) => a.replace("metalmind:", ""));
    } catch {
      // If keychain unavailable, check env vars
      const providers: string[] = [];
      for (const [key] of Object.entries(process.env)) {
        const match = key.match(/^METALMIND_(.+)_API_KEY$/);
        if (match?.[1]) providers.push(match[1].toLowerCase());
      }
      return providers;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
