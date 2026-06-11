import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadXdgConfig } from "@metalmind/config";
import { generatePkce, buildAuthUrl, exchangeCode, saveTokens } from "./oauth.js";

/**
 * Interactive OAuth authorization-code + PKCE flow for an MCP server (#199):
 * spins up a localhost redirect listener, opens the browser to the provider's
 * consent page, captures the returned code, exchanges it for tokens, and stores
 * them. Exercised live (needs a browser + a real provider); the pure pieces it
 * composes are unit-tested in oauth.ts.
 */

const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

function openBrowser(url: string): void {
  // macOS-only app, so `open` is the right launcher.
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

/** Wait for the OAuth redirect and resolve with the authorization code (or reject). */
function awaitRedirect(expectedState: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", REDIRECT_URI);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const error = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:sans-serif"><h2>${error ? "Authorization failed" : "Authorized — you can close this tab."}</h2></body></html>`);
      server.close();
      if (error) reject(new Error(error));
      else if (!code) reject(new Error("no code in redirect"));
      else if (state !== expectedState) reject(new Error("state mismatch (possible CSRF)"));
      else resolve(code);
    });
    server.on("error", reject);
    server.listen(REDIRECT_PORT);
    setTimeout(() => { server.close(); reject(new Error("authorization timed out")); }, timeoutMs).unref();
  });
}

/** Run the full flow for a configured MCP server id; returns a status message. */
export async function runMcpOAuth(serverId: string): Promise<string> {
  const srv = loadXdgConfig().mcpServers?.[serverId];
  if (!srv) return `No MCP server "${serverId}" configured.`;
  if (srv.authType !== "oauth2") return `Server "${serverId}" is not configured for OAuth.`;
  const oauth = srv.oauth;
  if (!oauth?.authEndpoint || !oauth.tokenEndpoint || !oauth.clientId) {
    return `Server "${serverId}" is missing OAuth endpoints. Set mcpServers.${serverId}.oauth = { authEndpoint, tokenEndpoint, clientId }.`;
  }

  const pkce = generatePkce();
  const state = generatePkce().verifier.slice(0, 16); // random, unguessable
  const authUrl = buildAuthUrl(oauth.authEndpoint, {
    clientId: oauth.clientId,
    redirectUri: REDIRECT_URI,
    scope: oauth.scope,
    challenge: pkce.challenge,
    state,
  });

  try {
    const redirect = awaitRedirect(state);
    openBrowser(authUrl);
    const code = await redirect;
    const tokens = await exchangeCode(oauth.tokenEndpoint, {
      code,
      verifier: pkce.verifier,
      clientId: oauth.clientId,
      redirectUri: REDIRECT_URI,
    });
    await saveTokens(serverId, tokens);
    return `Authorized "${serverId}". Token stored — reconnect to use it.`;
  } catch (err) {
    return `OAuth for "${serverId}" failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
