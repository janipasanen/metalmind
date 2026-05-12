import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { AgentMessage } from "@metalmind/schemas";

export interface SessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export class SqliteSessionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(process.cwd(), ".metalmind", "sessions.db");
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
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
      "INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)",
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
        );
      }
      updateSession.run(sessionId);
    });

    transaction();
  }

  loadMessages(sessionId: string): AgentMessage[] {
    const rows = this.db
      .prepare("SELECT role, content, tool_calls FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
    }>;

    return rows.map((row) => {
      const msg: AgentMessage = {
        role: row.role as AgentMessage["role"],
        content: row.content,
      };
      if (row.tool_calls) {
        try {
          msg.toolCalls = JSON.parse(row.tool_calls);
          msg.metadata = { hasToolCalls: true };
        } catch {
          // ignore parse errors
        }
      }
      return msg;
    });
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare(
        "SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
      )
      .all() as SessionRecord[];
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.db
      .prepare("SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRecord | undefined;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
