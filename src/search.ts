import { Database } from "bun:sqlite";

import { type ExternalMemoryProviderName } from "./config.ts";
import type { TranscriptItem } from "./review.ts";
import type { UnknownRecord } from "./shared.ts";

export interface IndexedMessage {
  id: string;
  session_id: string;
  ordinal: number;
  role: string;
  content: string;
}

export function excerpt(content: string, query = "", limit = 600): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  if (compact.length <= limit) return compact;
  const needle = query.trim().toLocaleLowerCase();
  const hit = needle ? compact.toLocaleLowerCase().indexOf(needle) : -1;
  const start = hit < 0 ? 0 : Math.max(0, hit - Math.floor(limit / 3));
  const end = Math.min(compact.length, start + limit);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function transcriptMessages(items: TranscriptItem[]): IndexedMessage[] {
  const messages: IndexedMessage[] = [];
  let ordinal = 0;
  for (const item of items) {
    if (item.text.trim()) {
      messages.push({
        id: item.id,
        session_id: "",
        ordinal,
        role: item.role,
        content: item.text.trim(),
      });
      ordinal += 1;
    }
    for (const [toolIndex, call] of item.toolCalls.entries()) {
      const chunks = [
        `tool=${call.name}`,
        `status=${call.status}`,
        call.input === undefined ? "" : `input=${safeJSONString(call.input)}`,
        call.output ? `output=${call.output}` : "",
      ].filter(Boolean);
      messages.push({
        id: `${item.id}:tool:${toolIndex}`,
        session_id: "",
        ordinal,
        role: "tool",
        content: chunks.join("\n"),
      });
      ordinal += 1;
    }
  }
  return messages;
}

function safeJSONString(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface SessionMetadata {
  id: string;
  title: string;
  directory: string;
  projectRoot: string;
  parentID?: string;
  createdAt: number;
  updatedAt: number;
}

export class SessionSearchStore {
  readonly path: string;
  private readonly db: Database;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        directory TEXT NOT NULL,
        project_root TEXT NOT NULL,
        parent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(session_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_session_ordinal
        ON messages(session_id, ordinal);
      CREATE TABLE IF NOT EXISTS external_sync (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY(provider, session_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  close(): void {
    this.db.close(false);
  }

  indexSession(metadata: SessionMetadata, items: TranscriptItem[]): void {
    const messages = transcriptMessages(items);
    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `
          INSERT INTO sessions (
            id, title, directory, project_root, parent_id, created_at, updated_at, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            directory=excluded.directory,
            project_root=excluded.project_root,
            parent_id=excluded.parent_id,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at,
            indexed_at=excluded.indexed_at
        `,
        )
        .run(
          metadata.id,
          metadata.title,
          metadata.directory,
          metadata.projectRoot,
          metadata.parentID ?? null,
          metadata.createdAt,
          metadata.updatedAt,
          Date.now(),
        );
      this.db
        .query("DELETE FROM messages WHERE session_id = ?")
        .run(metadata.id);
      const insert = this.db.query(
        "INSERT INTO messages (session_id, message_id, ordinal, role, content) VALUES (?, ?, ?, ?, ?)",
      );
      for (const message of messages) {
        insert.run(
          metadata.id,
          message.id,
          message.ordinal,
          message.role,
          message.content,
        );
      }
    });
    transaction();
  }

  removeSession(sessionID: string): void {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionID);
  }

  indexedSessionIDs(): Set<string> {
    const rows = this.db.query("SELECT id FROM sessions").all() as Array<{
      id: string;
    }>;
    return new Set(rows.map((row) => row.id));
  }

  isExternalTurnSynced(
    provider: ExternalMemoryProviderName,
    sessionID: string,
    messageID: string,
  ): boolean {
    const row = this.db
      .query(
        "SELECT message_id FROM external_sync WHERE provider=? AND session_id=?",
      )
      .get(provider, sessionID) as { message_id: string } | null;
    return row?.message_id === messageID;
  }

  markExternalTurnSynced(
    provider: ExternalMemoryProviderName,
    sessionID: string,
    messageID: string,
  ): void {
    this.db
      .query(
        `
        INSERT INTO external_sync (provider, session_id, message_id, synced_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, session_id) DO UPDATE SET
          message_id=excluded.message_id,
          synced_at=excluded.synced_at
      `,
      )
      .run(provider, sessionID, messageID, Date.now());
  }

  browse(limit = 10): UnknownRecord {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const sessions = this.db
      .query(
        `
        SELECT s.*, (
          SELECT content FROM messages m WHERE m.session_id=s.id ORDER BY ordinal LIMIT 1
        ) AS preview
        FROM sessions s
        ORDER BY updated_at DESC
        LIMIT ?
      `,
      )
      .all(safeLimit) as Array<UnknownRecord>;
    return {
      mode: "browse",
      count: sessions.length,
      sessions: sessions.map((session) => ({
        session_id: session.id,
        title: session.title,
        directory: session.directory,
        project_root: session.project_root,
        created_at: session.created_at,
        updated_at: session.updated_at,
        preview: excerpt(String(session.preview ?? ""), "", 300),
      })),
    };
  }

  search(input: {
    query: string;
    limit?: number;
    sort?: "newest" | "oldest";
    roles?: string[];
    window?: number;
  }): UnknownRecord {
    const query = input.query.trim();
    if (!query) return this.browse(input.limit);
    const limit = Math.max(1, Math.min(10, Math.trunc(input.limit ?? 3)));
    const window = Math.max(1, Math.min(20, Math.trunc(input.window ?? 5)));
    const roles = (
      input.roles?.length ? input.roles : ["user", "assistant"]
    ).filter((role) => ["user", "assistant", "tool"].includes(role));
    const placeholders = roles.map(() => "?").join(",") || "''";
    const order =
      input.sort === "newest"
        ? "s.updated_at DESC, score ASC"
        : input.sort === "oldest"
          ? "s.updated_at ASC, score ASC"
          : "score ASC, s.updated_at DESC";
    let rows: Array<
      IndexedMessage & {
        title: string;
        directory: string;
        project_root: string;
        updated_at: number;
        score: number;
      }
    >;
    try {
      rows = this.db
        .query(
          `
          SELECT m.message_id AS id, m.session_id, m.ordinal, m.role, m.content,
                 s.title, s.directory, s.project_root, s.updated_at,
                 bm25(messages_fts) AS score
          FROM messages_fts
          JOIN messages m ON m.rowid=messages_fts.rowid
          JOIN sessions s ON s.id=m.session_id
          WHERE messages_fts MATCH ? AND m.role IN (${placeholders})
          ORDER BY ${order}
          LIMIT ?
        `,
        )
        .all(query, ...roles, limit * 20) as typeof rows;
    } catch {
      rows = [];
    }
    if (!rows.length) {
      const terms = query
        .toLocaleLowerCase()
        .split(/\s+/u)
        .map((term) => term.trim())
        .filter(Boolean);
      const likeClauses =
        terms.map(() => "LOWER(m.content) LIKE ?").join(" AND ") || "1=1";
      const likeOrder =
        input.sort === "oldest" ? "s.updated_at ASC" : "s.updated_at DESC";
      rows = this.db
        .query(
          `
          SELECT m.message_id AS id, m.session_id, m.ordinal, m.role, m.content,
                 s.title, s.directory, s.project_root, s.updated_at, 0 AS score
          FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE ${likeClauses} AND m.role IN (${placeholders})
          ORDER BY ${likeOrder}
          LIMIT ?
        `,
        )
        .all(
          ...terms.map((term) => `%${term}%`),
          ...roles,
          limit * 20,
        ) as typeof rows;
    }
    const hits = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!hits.has(row.session_id)) hits.set(row.session_id, row);
      if (hits.size >= limit) break;
    }
    const results = [...hits.values()].map((hit) => ({
      session_id: hit.session_id,
      title: hit.title,
      directory: hit.directory,
      project_root: hit.project_root,
      updated_at: hit.updated_at,
      match_message_id: hit.id,
      snippet: excerpt(hit.content, query),
      bookend_start: this.bookend(hit.session_id, "ASC"),
      messages: this.window(hit.session_id, hit.ordinal, window, hit.id),
      bookend_end: this.bookend(hit.session_id, "DESC").reverse(),
    }));
    return { mode: "discover", query, count: results.length, results };
  }

  read(sessionID: string): UnknownRecord {
    const session = this.db
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(sessionID) as UnknownRecord | null;
    if (!session) throw new Error(`Indexed session not found: ${sessionID}`);
    const all = this.db
      .query(
        "SELECT message_id AS id, ordinal, role, content FROM messages WHERE session_id=? ORDER BY ordinal",
      )
      .all(sessionID) as IndexedMessage[];
    const messages =
      all.length <= 40 ? all : [...all.slice(0, 25), ...all.slice(-15)];
    return {
      mode: "read",
      session_id: sessionID,
      title: session.title,
      directory: session.directory,
      project_root: session.project_root,
      truncated: messages.length !== all.length,
      total_messages: all.length,
      messages,
    };
  }

  scroll(
    sessionID: string,
    aroundMessageID: string,
    window = 5,
  ): UnknownRecord {
    const anchor = this.db
      .query("SELECT ordinal FROM messages WHERE session_id=? AND message_id=?")
      .get(sessionID, aroundMessageID) as { ordinal: number } | null;
    if (!anchor)
      throw new Error(
        `Message ${aroundMessageID} was not found in session ${sessionID}`,
      );
    const safeWindow = Math.max(1, Math.min(20, Math.trunc(window)));
    return {
      mode: "scroll",
      session_id: sessionID,
      around_message_id: aroundMessageID,
      messages: this.window(
        sessionID,
        anchor.ordinal,
        safeWindow,
        aroundMessageID,
      ),
      messages_before: this.countBefore(sessionID, anchor.ordinal),
      messages_after: this.countAfter(sessionID, anchor.ordinal),
    };
  }

  private bookend(
    sessionID: string,
    direction: "ASC" | "DESC",
  ): IndexedMessage[] {
    return this.db
      .query(
        `
        SELECT message_id AS id, ordinal, role, content
        FROM messages
        WHERE session_id=? AND role IN ('user','assistant')
        ORDER BY ordinal ${direction}
        LIMIT 3
      `,
      )
      .all(sessionID) as IndexedMessage[];
  }

  private window(
    sessionID: string,
    ordinal: number,
    size: number,
    anchorID: string,
  ): UnknownRecord[] {
    return (
      this.db
        .query(
          `
          SELECT message_id AS id, ordinal, role, content
          FROM messages
          WHERE session_id=? AND ordinal BETWEEN ? AND ?
          ORDER BY ordinal
        `,
        )
        .all(
          sessionID,
          Math.max(0, ordinal - size),
          ordinal + size,
        ) as IndexedMessage[]
    ).map((message) => ({ ...message, anchor: message.id === anchorID }));
  }

  private countBefore(sessionID: string, ordinal: number): number {
    return Number(
      (
        this.db
          .query(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND ordinal<?",
          )
          .get(sessionID, ordinal) as { count: number }
      ).count,
    );
  }

  private countAfter(sessionID: string, ordinal: number): number {
    return Number(
      (
        this.db
          .query(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND ordinal>?",
          )
          .get(sessionID, ordinal) as { count: number }
      ).count,
    );
  }
}
