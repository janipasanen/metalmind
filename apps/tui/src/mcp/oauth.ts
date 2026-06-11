import { randomBytes, createHash } from "node:crypto";
import { loadXdgConfig, saveXdgConfig } from "@metalmind/config";

/**
 * OAuth 2.0 (PKCE) support for authenticated MCP servers (#199). The pure pieces
 * — PKCE, the authorization URL, code/refresh token exchange, expiry — are here
 * and unit-tested; the interactive browser+localhost-redirect dance lives in the
 * /mcp auth command. Tokens are stored in the macOS keychain when available, with
 * an XDG-config fallback.
 */

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  tokenType?: string;
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE verifier + S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function buildAuthUrl(
  authEndpoint: string,
  p: { clientId: string; redirectUri: string; scope?: string; challenge: string; state: string },
): string {
  const u = new URL(authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  if (p.scope) u.searchParams.set("scope", p.scope);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", p.state);
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function tokenRequest(tokenEndpoint: string, body: URLSearchParams): Promise<OAuthTokens> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type ?? "Bearer",
  };
}

export function exchangeCode(
  tokenEndpoint: string,
  p: { code: string; verifier: string; clientId: string; redirectUri: string },
): Promise<OAuthTokens> {
  return tokenRequest(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.verifier,
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
    }),
  );
}

export function refreshTokens(
  tokenEndpoint: string,
  p: { refreshToken: string; clientId: string },
): Promise<OAuthTokens> {
  return tokenRequest(
    tokenEndpoint,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId }),
  );
}

/** True if the access token is missing or within 60s of expiry. */
export function isExpired(tokens: OAuthTokens | null | undefined): boolean {
  if (!tokens?.accessToken) return true;
  if (!tokens.expiresAt) return false;
  return Date.now() >= tokens.expiresAt - 60_000;
}

// ---- storage (keychain-first, XDG fallback) ----

const account = (serverId: string) => `mcp-oauth-${serverId}`;

export async function saveTokens(serverId: string, tokens: OAuthTokens): Promise<void> {
  const stored = await keychainSet(account(serverId), JSON.stringify(tokens));
  if (!stored) {
    const cfg = loadXdgConfig();
    saveXdgConfig({ ...cfg, mcpTokens: { ...(cfg.mcpTokens ?? {}), [serverId]: tokens } });
  }
}

export async function loadTokens(serverId: string): Promise<OAuthTokens | null> {
  const fromKeychain = await keychainGet(account(serverId));
  if (fromKeychain) {
    try {
      return JSON.parse(fromKeychain) as OAuthTokens;
    } catch {
      /* fall through */
    }
  }
  return loadXdgConfig().mcpTokens?.[serverId] ?? null;
}

/** Return a valid access token, refreshing if expired; null if not authorized. */
export async function getValidAccessToken(
  serverId: string,
  opts: { tokenEndpoint: string; clientId: string },
): Promise<string | null> {
  const tokens = await loadTokens(serverId);
  if (!tokens) return null;
  if (!isExpired(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  try {
    const refreshed = await refreshTokens(opts.tokenEndpoint, { refreshToken: tokens.refreshToken, clientId: opts.clientId });
    // Some providers omit a new refresh_token on refresh — keep the old one.
    const merged = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
    await saveTokens(serverId, merged);
    return merged.accessToken;
  } catch {
    return null;
  }
}

// Lazy, optional macOS keychain (the Swift helper may be absent, e.g. in tests/CI).
async function keychainSet(acct: string, value: string): Promise<boolean> {
  try {
    const { keychain } = await import("@metalmind/apple");
    return await keychain.set(acct, value);
  } catch {
    return false;
  }
}
async function keychainGet(acct: string): Promise<string | null> {
  try {
    const { keychain } = await import("@metalmind/apple");
    return await keychain.get(acct);
  } catch {
    return null;
  }
}
