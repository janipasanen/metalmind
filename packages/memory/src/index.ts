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

  saveMessages(sessionId: string, messages: AgentMessage[]): void {
    const insertMsg = this.db.prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls, images, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    );

    const deleteAll = this.db.prepare("DELETE FROM messages WHERE session_id = ?");

    const updateSession = this.db.prepare(
      "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?",
    );

    const transaction = this.db.transaction(() => {
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
      updateSession.run(sessionId);
    });

    transaction();
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
