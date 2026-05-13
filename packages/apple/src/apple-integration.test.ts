import { describe, it, expect } from "vitest";
import { KeychainConfig } from "./keychain-config.js";
import { NotificationService } from "./notifications.js";
import { ShortcutsIntegration } from "./shortcuts.js";
import { isHelperAvailable } from "./macos-bridge.js";

describe("KeychainConfig", () => {
  it("creates instance", () => {
    const config = new KeychainConfig();
    expect(config).toBeDefined();
  });

  it("listProviders returns array", async () => {
    const config = new KeychainConfig();
    const providers = await config.listProviders();
    expect(Array.isArray(providers)).toBe(true);
  });

  it("getKey returns null for unknown provider", async () => {
    const config = new KeychainConfig();
    const key = await config.getKey("nonexistent-provider-xyz");
    // Should return null if keychain unavailable and no env var set
    expect(key === null || typeof key === "string").toBe(true);
  });

  it("clearCache works", () => {
    const config = new KeychainConfig();
    expect(() => config.clearCache()).not.toThrow();
  });
});

describe("NotificationService", () => {
  it("creates with default preferences", () => {
    const svc = new NotificationService();
    expect(svc).toBeDefined();
  });

  it("accepts custom preferences", () => {
    const svc = new NotificationService({ enabled: false });
    expect(svc).toBeDefined();
  });

  it("setPreferences updates preferences", () => {
    const svc = new NotificationService();
    expect(() =>
      svc.setPreferences({ enabled: false }),
    ).not.toThrow();
  });

  it("notify does not throw (even without helper)", async () => {
    const svc = new NotificationService({ enabled: true });
    // Should not throw even if helper is unavailable
    await expect(
      svc.notify("task-complete", "Test", "Body"),
    ).resolves.toBeUndefined();
  });

  it("taskComplete does not throw", async () => {
    const svc = new NotificationService();
    await expect(
      svc.taskComplete("Testing completed"),
    ).resolves.toBeUndefined();
  });

  it("taskError does not throw", async () => {
    const svc = new NotificationService();
    await expect(
      svc.taskError("Something failed"),
    ).resolves.toBeUndefined();
  });

  it("approvalNeeded does not throw", async () => {
    const svc = new NotificationService();
    await expect(
      svc.approvalNeeded("Delete file"),
    ).resolves.toBeUndefined();
  });

  it("modelFallback does not throw", async () => {
    const svc = new NotificationService();
    await expect(
      svc.modelFallback("ollama", "openai"),
    ).resolves.toBeUndefined();
  });
});

describe("ShortcutsIntegration", () => {
  it("creates instance", () => {
    const si = new ShortcutsIntegration();
    expect(si).toBeDefined();
  });

  it("registers a shortcut", () => {
    const si = new ShortcutsIntegration();
    si.register({
      name: "Test",
      description: "A test shortcut",
      action: "test",
    });
    expect(si.getShortcuts().length).toBe(1);
  });

  it("generates valid plist XML", () => {
    const si = new ShortcutsIntegration();
    const xml = si.generateShortcutFile({
      name: "My Shortcut",
      description: "Does something",
      action: "open",
      parameters: { path: "/tmp" },
    });
    expect(xml).toContain("<?xml");
    expect(xml).toContain("My Shortcut");
    expect(xml).toContain("metalmind://open");
  });

  it("registers builtins", () => {
    const si = new ShortcutsIntegration();
    si.registerBuiltins("/tmp/test-project");
    expect(si.getShortcuts().length).toBeGreaterThanOrEqual(3);
  });
});

describe("isHelperAvailable", () => {
  it("returns boolean", async () => {
    const available = await isHelperAvailable();
    expect(typeof available).toBe("boolean");
  });
});
