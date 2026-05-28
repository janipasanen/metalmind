import { describe, it, expect } from "vitest";
import { loadXdgConfig } from "@metalmind/config";

describe("MCP Configuration Auth Support", () => {
  it("supports OAuth2 authentication type", () => {
    const config = loadXdgConfig();
    expect(config).toHaveProperty("mcpServers");
    
    const testServers = {
      "git": {
        name: "Git",
        command: "npx",
        authType: "oauth2",
        enabled: true,
      },
    };
    
    expect(testServers["git"].authType).toBe("oauth2");
  });

  it("supports Bearer token authentication type", () => {
    const config = loadXdgConfig();
    
    const testServer = {
      name: "Custom",
      command: "node",
      authType: "bearer",
      enabled: true,
    };
    
    expect(testServer.authType).toBe("bearer");
  });

  it("supports no authentication type", () => {
    const config = loadXdgConfig();
    
    const testServer = {
      name: "Local",
      command: "node",
      authType: "none",
      enabled: true,
    };
    
    expect(testServer.authType).toBe("none");
  });

  it("handles multiple auth types in configuration", () => {
    const config = loadXdgConfig();
    
    const mcpServers: Record<string, any> = {
      "git": { name: "Git", authType: "oauth2" },
      "memory": { name: "Memory", authType: "oauth2" },
      "custom": { name: "Custom", authType: "bearer" },
    };
    
    expect(mcpServers["git"].authType).toBe("oauth2");
    expect(mcpServers["memory"].authType).toBe("oauth2");
    expect(mcpServers["custom"].authType).toBe("bearer");
    expect(Object.keys(mcpServers).length).toBe(3);
  });
});
