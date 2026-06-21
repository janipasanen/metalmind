import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake McpClient so we can simulate a crash (a "disconnect" event) without a
// real stdio server, and assert the registry recovers (#259). The factory is
// hoisted above imports, so it imports EventEmitter itself.
const h = vi.hoisted(() => ({ instances: [] as Array<{ connected: boolean; emit(e: string): void }> }));

vi.mock("./mcp-client.js", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeMcpClient extends EventEmitter {
    connected = false;
    tools = [{ name: "echo", description: "echo", inputSchema: {} }];
    constructor(_config: unknown) {
      super();
      h.instances.push(this as unknown as { connected: boolean; emit(e: string): void });
    }
    async connect() {
      this.connected = true;
    }
    async disconnect() {
      this.connected = false;
    }
    async callTool() {
      return "ok";
    }
  }
  return { McpClient: FakeMcpClient };
});

import { McpToolRegistry } from "./mcp-tool-registry.js";

describe("McpToolRegistry reconnect after a crash (#259)", () => {
  beforeEach(() => {
    h.instances.length = 0;
  });

  it("evicts a crashed client so isConnected is truthful and reconnect succeeds", async () => {
    const reg = new McpToolRegistry();
    const cfg = { name: "srv", command: "x", args: [] };

    const tools = await reg.connectServer(cfg);
    expect(tools).toHaveLength(1);
    expect(reg.isConnected("srv")).toBe(true);
    expect(reg.getTools()).toHaveLength(1);

    // Simulate a server crash: the client emits "disconnect".
    h.instances[0].connected = false;
    h.instances[0].emit("disconnect");

    // The registry must reflect reality and drop the tools...
    expect(reg.isConnected("srv")).toBe(false);
    expect(reg.getTools()).toHaveLength(0);

    // ...and a reconnect must not throw "already connected".
    await expect(reg.connectServer(cfg)).resolves.toHaveLength(1);
    expect(reg.isConnected("srv")).toBe(true);
  });
});
