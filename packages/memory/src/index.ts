import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { mkdirSync, renameSync, existsSync } from "node:fs";
import type { AgentMessage } from "@metalmind/schemas";

export interface SessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  tags: string;
}

/** Raised when an optimistic save loses a race with another instance (#388). */
export class SessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConflictError";
  }
}

export class SqliteSessionStore {
  private db: Database.Database;
  /** Set when a corrupt db file was quarantined and a fresh one created (#332).
   *  The caller should surface this to the user (the old file is preserved). */
  readonly recoveredFromCorruption: string | null = null;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(process.cwd(), ".metalmind", "sessions.db");
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    try {
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.initSchema();
      this.migrate();
    } catch (err) {
      // A corrupt/truncated db (SQLITE_NOTADB/SQLITE_CORRUPT) must not silently
      // kill persistence for the whole session. Quarantine the file (plus WAL
      // siblings) with a timestamp and start fresh — old data stays on disk (#332).
      const code = (err as { code?: string }).code ?? "";
      if (!/NOTADB|CORRUPT/.test(code)) throw err;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = path + suffix;
        try {
          if (existsSync(f)) renameSync(f, `${f}.corrupt-${stamp}`);
        } catch {
          /* best-effort */
        }
      }
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.initSchema();
      this.migrate();
      (this as { recoveredFromCorruption: string | null }).recoveredFromCorruption = `${path}.corrupt-${stamp}`;
    }
  }

  /** Add columns introduced after the initial schema, idempotently (#202/#236). */
  private migrate(): void {
    const sessionCols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionCols.some((c) => c.name === "tags")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
    }
    // Concurrency guard (#388): saveMessages rewrites a session's whole message
    // list, so two instances sharing a session id silently deleted each other's
    // turns. `rev` makes the write optimistic; owner_pid/heartbeat let a second
    // instance SEE that a session is live before adopting it.
    if (!sessionCols.some((c) => c.name === "rev")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionCols.some((c) => c.name === "owner_pid")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN owner_pid INTEGER");
    }
    if (!sessionCols.some((c) => c.name === "heartbeat")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN heartbeat TEXT");
    }
    // Persist image attachments and message metadata (e.g. tool_call_id) so resume
    // doesn't lose vision input or break tool_call/tool_result pairing (#236).
    const msgCols = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!msgCols.some((c) => c.name === "images")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
    }
    if (!msgCols.some((c) => c.name === "metadata")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    `);
  }

  createSession(title = ""): string {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare("INSERT INTO sessions (id, title) VALUES (?, ?)")
      .run(id, title);
    return id;
  }

  /** Revision this process last wrote per session, for optimistic saves (#388). */
  private knownRev = new Map<string, number>();

  /** Adopt a session for writing: record its current revision and claim it.
   *  Call once after resolving which session this process will write to. */
  claimSession(sessionId: string): void {
    const row = this.db.prepare("SELECT rev FROM sessions WHERE id = ?").get(sessionId) as { rev?: number } | undefined;
    this.knownRev.set(sessionId, row?.rev ?? 0);
    try {
      this.db
        .prepare("UPDATE sessions SET owner_pid = ?, heartbeat = datetime('now') WHERE id = ?")
        .run(process.pid, sessionId);
    } catch {
      /* best-effort */
    }
  }

  /** Whether another LIVE process is currently writing this session (#388).
   *  "Live" = a different pid that still exists and beat within `staleSeconds`. */
  activeOwner(sessionId: string, staleSeconds = 120): number | null {
    const row = this.db
      .prepare("SELECT owner_pid AS pid, (julianday('now') - julianday(heartbeat)) * 86400 AS age FROM sessions WHERE id = ?")
      .get(sessionId) as { pid?: number | null; age?: number | null } | undefined;
    const pid = row?.pid ?? null;
    if (!pid || pid === process.pid) return null;
    if (row?.age == null || row.age > staleSeconds) return null;
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return pid;
    } catch (err) {
      // EPERM means the process EXISTS but belongs to another user — still a
      // live owner. Only ESRCH ("no such process") means the session is free.
      if ((err as { code?: string }).code === "EPERM") return pid;
      return null;
    }
  }

  /**
   * Persist a session's messages. The write is OPTIMISTIC (#388): it only lands
   * if the row's revision still matches what this process last saw. If another
   * instance wrote in between, the save is refused instead of silently deleting
   * that instance's turns — the caller surfaces it and can branch to a new id.
   */
  saveMessages(sessionId: string, messages: AgentMessage[]): void {
    const insertMsg = this.db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls, images, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    );

    const deleteAll = this.db.prepare("DELETE FROM messages WHERE session_id = ?");

    const bumpRev = this.db.prepare(
      "UPDATE sessions SET updated_at = datetime('now'), heartbeat = datetime('now'), owner_pid = ?, rev = rev + 1 WHERE id = ? AND rev = ?",
    );

    const expected = this.knownRev.get(sessionId);
    // First write from this process for this session — adopt whatever is there.
    if (expected === undefined) this.claimSession(sessionId);
    const rev = this.knownRev.get(sessionId) ?? 0;

    let conflicted = false;
    const transaction = this.db.transaction(() => {
      const res = bumpRev.run(process.pid, sessionId, rev);
      if (res.changes === 0) {
        conflicted = true;
        return; // leave the other instance's messages untouched
      }
      deleteAll.run(sessionId);
      for (const msg of messages) {
        insertMsg.run(
          sessionId,
          msg.role,
          msg.content,
          msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
          msg.images?.length ? JSON.stringify(msg.images) : null,
          msg.metadata ? JSON.stringify(msg.metadata) : null,
        );
      }
    });

    transaction();
    if (conflicted) {
      throw new SessionConflictError(
        `Session ${sessionId} was modified by another MetalMind instance (pid ${
          (this.db.prepare("SELECT owner_pid AS pid FROM sessions WHERE id = ?").get(sessionId) as { pid?: number })?.pid ?? "?"
        }). This turn was NOT saved to it.`,
      );
    }
    this.knownRev.set(sessionId, rev + 1);
  }

  loadMessages(sessionId: string): AgentMessage[] {
    const rows = this.db
      .prepare("SELECT role, content, tool_calls, images, metadata FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
      images: string | null;
      metadata: string | null;
    }>;

    return rows.map((row) => {
      const msg: AgentMessage = {
        role: row.role as AgentMessage["role"],
        content: row.content,
      };
      if (row.tool_calls) {
        try {
          msg.toolCalls = JSON.parse(row.tool_calls);
        } catch {
          // ignore parse errors
        }
      }
      if (row.images) {
        try {
          msg.images = JSON.parse(row.images);
        } catch {
          // ignore
        }
      }
      // Restore metadata (e.g. toolCallId for tool messages) so resume keeps
      // tool_call/tool_result pairing intact (#236).
      if (row.metadata) {
        try {
          msg.metadata = JSON.parse(row.metadata);
        } catch {
          // ignore
        }
      } else if (msg.toolCalls) {
        msg.metadata = { hasToolCalls: true };
      }
      return msg;
    });
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare(
        "SELECT id, title, created_at, updated_at, tags FROM sessions ORDER BY updated_at DESC",
      )
      .all() as SessionRecord[];
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.db
      .prepare("SELECT id, title, created_at, updated_at, tags FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRecord | undefined;
  }

  /** Full-text search across session titles, tags, and message content (#202). */
  searchSessions(query: string): SessionRecord[] {
    const like = `%${query}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT s.id, s.title, s.created_at, s.updated_at, s.tags
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.title LIKE ? OR s.tags LIKE ? OR m.content LIKE ?
         ORDER BY s.updated_at DESC`,
      )
      .all(like, like, like) as SessionRecord[];
  }

  /** Rename a session (#202). */
  renameSession(sessionId: string, title: string): void {
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, sessionId);
  }

  /** Set (replace) a session's tags — comma-separated (#202). */
  tagSession(sessionId: string, tags: string): void {
    this.db.prepare("UPDATE sessions SET tags = ? WHERE id = ?").run(tags, sessionId);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
