import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { XDG_CONFIG_FILE } from "@metalmind/config";
import {
  generatePkce,
  buildAuthUrl,
  exchangeCode,
  refreshTokens,
  isExpired,
  saveTokens,
  loadTokens,
  getValidAccessToken,
} from "../mcp/oauth.js";

describe("OAuth PKCE + URL (#199)", () => {
  it("generates a verifier and a matching S256 challenge", () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe("S256");
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("builds an authorization URL with PKCE params", () => {
    const url = new URL(buildAuthUrl("https://auth.example/authorize", {
      clientId: "cid", redirectUri: "http://127.0.0.1:8765/callback", scope: "read", challenge: "chal", state: "st",
    }));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("OAuth token exchange + expiry (#199)", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockToken(resp: Record<string, unknown>) {
    return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => resp, text: async () => "" });
  }

  it("exchanges an auth code for tokens with an expiry", async () => {
    vi.stubGlobal("fetch", mockToken({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }));
    const t = await exchangeCode("https://auth/token", { code: "c", verifier: "v", clientId: "cid", redirectUri: "r" });
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe("rt");
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes tokens", async () => {
    vi.stubGlobal("fetch", mockToken({ access_token: "at2", expires_in: 3600 }));
    const t = await refreshTokens("https://auth/token", { refreshToken: "rt", clientId: "cid" });
    expect(t.accessToken).toBe("at2");
  });

  it("treats missing/near-expiry tokens as expired", () => {
    expect(isExpired(null)).toBe(true);
    expect(isExpired({ accessToken: "x" })).toBe(false); // no expiry → assume valid
    expect(isExpired({ accessToken: "x", expiresAt: Date.now() + 10_000 })).toBe(true); // within 60s window
    expect(isExpired({ accessToken: "x", expiresAt: Date.now() + 600_000 })).toBe(false);
  });
});

describe("OAuth token storage (XDG fallback) (#199)", () => {
  let backup: string | null = null;
  beforeEach(() => { backup = existsSync(XDG_CONFIG_FILE) ? readFileSync(XDG_CONFIG_FILE, "utf-8") : null; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (backup !== null) writeFileSync(XDG_CONFIG_FILE, backup);
    else if (existsSync(XDG_CONFIG_FILE)) rmSync(XDG_CONFIG_FILE);
  });

  it("round-trips tokens through the XDG store (keychain unavailable)", async () => {
    await saveTokens("atlassian", { accessToken: "abc", refreshToken: "ref", tokenType: "Bearer" });
    const loaded = await loadTokens("atlassian");
    expect(loaded?.accessToken).toBe("abc");
  });

  it("getValidAccessToken refreshes an expired token and persists the new one", async () => {
    await saveTokens("srv", { accessToken: "old", refreshToken: "ref", expiresAt: Date.now() - 1000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: "fresh", expires_in: 3600 }), text: async () => "" }));
    const token = await getValidAccessToken("srv", { tokenEndpoint: "https://auth/token", clientId: "cid" });
    expect(token).toBe("fresh");
    expect((await loadTokens("srv"))?.accessToken).toBe("fresh");
  });

  it("returns null when there are no tokens", async () => {
    expect(await getValidAccessToken("never-authed", { tokenEndpoint: "x", clientId: "y" })).toBeNull();
  });
});
