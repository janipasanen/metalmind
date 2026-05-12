import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSessionStore } from "./index.js";

describe("SqliteSessionStore", () => {
  const testDir = join(tmpdir(), `metalmind-sessions-${Date.now()}`);
  const dbPath = join(testDir, "sessions.db");

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates a session and retrieves it", () => {
    const store = new SqliteSessionStore(dbPath);

    const sessionId = store.createSession("Test session");
    const sessions = store.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("Test session");
    expect(sessions[0].id).toBe(sessionId);

    store.close();
  });

  it("saves and loads messages", () => {
    const store = new SqliteSessionStore(dbPath);
    const sessionId = store.createSession("Chat");

    const messages = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there!" },
    ];

    store.saveMessages(sessionId, messages);
    const loaded = store.loadMessages(sessionId);

    expect(loaded).toHaveLength(3);
    expect(loaded[0].role).toBe("system");
    expect(loaded[1].role).toBe("user");
    expect(loaded[2].content).toBe("Hi there!");

    store.close();
  });

  it("persists tool calls in messages", () => {
    const store = new SqliteSessionStore(dbPath);
    const sessionId = store.createSession("Tools");

    const messages = [
      {
        role: "assistant" as const,
        content: "Let me read the file",
        toolCalls: [
          {
            toolCallId: "tc-1",
            toolName: "readFile",
            argumentsJson: '{"path":"/test.ts"}',
          },
        ],
      },
    ];

    store.saveMessages(sessionId, messages);
    const loaded = store.loadMessages(sessionId);

    expect(loaded[0].toolCalls).toHaveLength(1);
    expect(loaded[0].toolCalls![0].toolName).toBe("readFile");
    expect(loaded[0].toolCalls![0].argumentsJson).toBe('{"path":"/test.ts"}');

    store.close();
  });

  it("returns empty array for unknown session", () => {
    const store = new SqliteSessionStore(dbPath);
    const messages = store.loadMessages("nonexistent-id");
    expect(messages).toEqual([]);
    store.close();
  });

  it("lists sessions sorted by updated_at desc", async () => {
    const store = new SqliteSessionStore(dbPath);

    const id1 = store.createSession("First");
    await new Promise((r) => setTimeout(r, 1100));

    const id2 = store.createSession("Second");

    store.saveMessages(id2, [{ role: "user", content: "newer" }]);

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].title).toBe("Second");

    store.close();
  });

  it("deletes a session and its messages cascade", () => {
    const store = new SqliteSessionStore(dbPath);
    const sessionId = store.createSession("To delete");
    store.saveMessages(sessionId, [
      { role: "user", content: "msg" },
    ]);

    store.deleteSession(sessionId);
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(0);

    const messages = store.loadMessages(sessionId);
    expect(messages).toHaveLength(0);

    store.close();
  });

  it("updates session timestamp on message save", async () => {
    const store = new SqliteSessionStore(dbPath);
    const sessionId = store.createSession("Stamps");

    await new Promise((r) => setTimeout(r, 1100));

    const session1 = store.getSession(sessionId);
    const originalUpdated = session1!.updated_at;

    store.saveMessages(sessionId, [
      { role: "user", content: "new message" },
    ]);

    const session2 = store.getSession(sessionId);
    expect(session2!.updated_at).not.toBe(originalUpdated);

    store.close();
  });

  it("getSession returns undefined for nonexistent", () => {
    const store = new SqliteSessionStore(dbPath);
    expect(store.getSession("nonexistent")).toBeUndefined();
    store.close();
  });
});
