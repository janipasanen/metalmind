import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteSessionStore, SessionConflictError } from "./index.js";

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

  it("close() releases the handle so the db can be reopened (#242)", () => {
    const a = new SqliteSessionStore(dbPath);
    const id = a.createSession("persisted");
    a.close();
    // A reload (model/provider switch) opens a fresh store on the same file; the
    // prior handle must be released so this neither locks nor loses data.
    const b = new SqliteSessionStore(dbPath);
    expect(b.listSessions().map((s) => s.id)).toContain(id);
    b.close();
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

  describe("search, rename, tags (#202)", () => {
    it("searches across message content, titles, and tags", () => {
      const store = new SqliteSessionStore(dbPath);
      const a = store.createSession("Refactor auth");
      store.saveMessages(a, [{ role: "user", content: "rewrite the login flow with JWT" }]);
      const b = store.createSession("Docs work");
      store.saveMessages(b, [{ role: "user", content: "update the README" }]);

      expect(store.searchSessions("JWT").map((s) => s.id)).toEqual([a]);
      expect(store.searchSessions("README").map((s) => s.id)).toEqual([b]);
      expect(store.searchSessions("Refactor").map((s) => s.id)).toEqual([a]); // title match
      expect(store.searchSessions("nothinghere")).toHaveLength(0);
      store.close();
    });

    it("renames a session", () => {
      const store = new SqliteSessionStore(dbPath);
      const id = store.createSession("old");
      store.renameSession(id, "new name");
      expect(store.getSession(id)!.title).toBe("new name");
      store.close();
    });

    it("tags a session and finds it by tag", () => {
      const store = new SqliteSessionStore(dbPath);
      const id = store.createSession("Tagged");
      store.tagSession(id, "work,urgent");
      expect(store.getSession(id)!.tags).toBe("work,urgent");
      expect(store.searchSessions("urgent").map((s) => s.id)).toEqual([id]);
      store.close();
    });

    it("defaults tags to an empty string for new sessions", () => {
      const store = new SqliteSessionStore(dbPath);
      const id = store.createSession("Untagged");
      expect(store.getSession(id)!.tags).toBe("");
      store.close();
    });
  });
});

describe("SqliteSessionStore persists images + metadata (#236)", () => {
  const testDir = join(tmpdir(), `metalmind-meta-${Date.now()}`);
  const dbPath = join(testDir, "s.db");
  beforeEach(() => rmSync(testDir, { recursive: true, force: true }));
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  it("round-trips image attachments and tool metadata across resume", () => {
    const store = new SqliteSessionStore(dbPath);
    const id = store.createSession("s");
    store.saveMessages(id, [
      { role: "user", content: "look", images: ["data:image/png;base64,AAAA"] },
      { role: "assistant", content: "", toolCalls: [{ toolCallId: "tc1", toolName: "readFile", argumentsJson: "{}" }] },
      { role: "tool", content: "result", metadata: { toolCallId: "tc1" } },
    ]);
    const loaded = store.loadMessages(id);
    expect(loaded[0].images).toEqual(["data:image/png;base64,AAAA"]);
    expect(loaded[2].metadata?.toolCallId).toBe("tc1"); // tool_call/tool_result pairing preserved
    store.close();
  });
});

describe("concurrent instances (#388)", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mm-conc-"));
    dbPath = join(dir, "sessions.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses a stale save instead of deleting the other instance's turns", () => {
    const a = new SqliteSessionStore(dbPath);
    const b = new SqliteSessionStore(dbPath);
    const id = a.createSession("shared");
    a.claimSession(id);
    b.claimSession(id); // second instance adopts the same session

    a.saveMessages(id, [{ role: "user", content: "A1" }, { role: "assistant", content: "A2" }]);

    // B's view of the revision is now stale — its save must be refused.
    expect(() => b.saveMessages(id, [{ role: "user", content: "B1" }])).toThrow(SessionConflictError);
    expect(a.loadMessages(id).map((m) => m.content)).toEqual(["A1", "A2"]);

    a.close();
    b.close();
  });

  it("lets the owner keep saving across many turns", () => {
    const a = new SqliteSessionStore(dbPath);
    const id = a.createSession();
    a.claimSession(id);
    for (let i = 1; i <= 5; i++) {
      a.saveMessages(id, Array.from({ length: i }, (_, k) => ({ role: "user" as const, content: `turn ${k + 1}` })));
    }
    expect(a.loadMessages(id)).toHaveLength(5);
    a.close();
  });

  it("reports a live foreign owner and ignores a dead or stale one", () => {
    const store = new SqliteSessionStore(dbPath);
    const id = store.createSession();
    const raw = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;

    // A different, definitely-alive pid (pid 1 always exists on macOS).
    raw.prepare("UPDATE sessions SET owner_pid = 1, heartbeat = datetime('now') WHERE id = ?").run(id);
    expect(store.activeOwner(id)).toBe(1);

    // Same pid as us → never blocks ourselves.
    raw.prepare("UPDATE sessions SET owner_pid = ?, heartbeat = datetime('now') WHERE id = ?").run(process.pid, id);
    expect(store.activeOwner(id)).toBeNull();

    // A stale heartbeat frees the session even if the pid is alive.
    raw.prepare("UPDATE sessions SET owner_pid = 1, heartbeat = datetime('now', '-10 minutes') WHERE id = ?").run(id);
    expect(store.activeOwner(id)).toBeNull();

    // A pid that cannot exist frees it too.
    raw.prepare("UPDATE sessions SET owner_pid = 999999, heartbeat = datetime('now') WHERE id = ?").run(id);
    expect(store.activeOwner(id)).toBeNull();
    store.close();
  });
});
