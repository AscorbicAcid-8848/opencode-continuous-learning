import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Database } from "bun:sqlite"

import {
  LearningStore,
  atomicWriteText,
  withStorageLock,
  type ExternalMemoryProviderName,
  type LearningConfig,
  type MemoryTarget,
  type SkillOwner,
  type TranscriptItem,
} from "./core.ts"

type UnknownRecord = Record<string, unknown>

export interface SessionMetadata {
  id: string
  title: string
  directory: string
  projectRoot: string
  parentID?: string
  createdAt: number
  updatedAt: number
}

type IndexedMessage = {
  id: string
  session_id: string
  ordinal: number
  role: string
  content: string
}

function excerpt(content: string, query = "", limit = 600): string {
  const compact = content.replace(/\s+/gu, " ").trim()
  if (compact.length <= limit) return compact
  const needle = query.trim().toLocaleLowerCase()
  const hit = needle ? compact.toLocaleLowerCase().indexOf(needle) : -1
  const start = hit < 0 ? 0 : Math.max(0, hit - Math.floor(limit / 3))
  const end = Math.min(compact.length, start + limit)
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`
}

function transcriptMessages(items: TranscriptItem[]): IndexedMessage[] {
  const messages: IndexedMessage[] = []
  let ordinal = 0
  for (const item of items) {
    if (item.text.trim()) {
      messages.push({
        id: item.id,
        session_id: "",
        ordinal,
        role: item.role,
        content: item.text.trim(),
      })
      ordinal += 1
    }
    for (const [toolIndex, call] of item.toolCalls.entries()) {
      const chunks = [
        `tool=${call.name}`,
        `status=${call.status}`,
        call.input === undefined ? "" : `input=${safeJSONString(call.input)}`,
        call.output ? `output=${call.output}` : "",
      ].filter(Boolean)
      messages.push({
        id: `${item.id}:tool:${toolIndex}`,
        session_id: "",
        ordinal,
        role: "tool",
        content: chunks.join("\n"),
      })
      ordinal += 1
    }
  }
  return messages
}

function safeJSONString(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export class SessionSearchStore {
  readonly path: string
  private readonly db: Database

  constructor(path: string) {
    this.path = path
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
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
    `)
  }

  close(): void {
    this.db.close(false)
  }

  indexSession(metadata: SessionMetadata, items: TranscriptItem[]): void {
    const messages = transcriptMessages(items)
    const transaction = this.db.transaction(() => {
      this.db
        .query(`
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
        `)
        .run(
          metadata.id,
          metadata.title,
          metadata.directory,
          metadata.projectRoot,
          metadata.parentID ?? null,
          metadata.createdAt,
          metadata.updatedAt,
          Date.now(),
        )
      this.db.query("DELETE FROM messages WHERE session_id = ?").run(metadata.id)
      const insert = this.db.query(
        "INSERT INTO messages (session_id, message_id, ordinal, role, content) VALUES (?, ?, ?, ?, ?)",
      )
      for (const message of messages) {
        insert.run(metadata.id, message.id, message.ordinal, message.role, message.content)
      }
    })
    transaction()
  }

  removeSession(sessionID: string): void {
    this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionID)
  }

  indexedSessionIDs(): Set<string> {
    const rows = this.db.query("SELECT id FROM sessions").all() as Array<{ id: string }>
    return new Set(rows.map((row) => row.id))
  }

  isExternalTurnSynced(
    provider: ExternalMemoryProviderName,
    sessionID: string,
    messageID: string,
  ): boolean {
    const row = this.db
      .query("SELECT message_id FROM external_sync WHERE provider=? AND session_id=?")
      .get(provider, sessionID) as { message_id: string } | null
    return row?.message_id === messageID
  }

  markExternalTurnSynced(
    provider: ExternalMemoryProviderName,
    sessionID: string,
    messageID: string,
  ): void {
    this.db
      .query(`
        INSERT INTO external_sync (provider, session_id, message_id, synced_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, session_id) DO UPDATE SET
          message_id=excluded.message_id,
          synced_at=excluded.synced_at
      `)
      .run(provider, sessionID, messageID, Date.now())
  }

  browse(limit = 10): UnknownRecord {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)))
    const sessions = this.db
      .query(`
        SELECT s.*, (
          SELECT content FROM messages m WHERE m.session_id=s.id ORDER BY ordinal LIMIT 1
        ) AS preview
        FROM sessions s
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(safeLimit) as Array<UnknownRecord>
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
    }
  }

  search(input: {
    query: string
    limit?: number
    sort?: "newest" | "oldest"
    roles?: string[]
    window?: number
  }): UnknownRecord {
    const query = input.query.trim()
    if (!query) return this.browse(input.limit)
    const limit = Math.max(1, Math.min(10, Math.trunc(input.limit ?? 3)))
    const window = Math.max(1, Math.min(20, Math.trunc(input.window ?? 5)))
    const roles = (input.roles?.length ? input.roles : ["user", "assistant"]).filter((role) =>
      ["user", "assistant", "tool"].includes(role),
    )
    const placeholders = roles.map(() => "?").join(",") || "''"
    const order =
      input.sort === "newest"
        ? "s.updated_at DESC, score ASC"
        : input.sort === "oldest"
          ? "s.updated_at ASC, score ASC"
          : "score ASC, s.updated_at DESC"
    let rows: Array<IndexedMessage & { title: string; directory: string; project_root: string; updated_at: number; score: number }>
    try {
      rows = this.db
        .query(`
          SELECT m.message_id AS id, m.session_id, m.ordinal, m.role, m.content,
                 s.title, s.directory, s.project_root, s.updated_at,
                 bm25(messages_fts) AS score
          FROM messages_fts
          JOIN messages m ON m.rowid=messages_fts.rowid
          JOIN sessions s ON s.id=m.session_id
          WHERE messages_fts MATCH ? AND m.role IN (${placeholders})
          ORDER BY ${order}
          LIMIT ?
        `)
        .all(query, ...roles, limit * 20) as typeof rows
    } catch {
      rows = []
    }
    if (!rows.length) {
      const terms = query
        .toLocaleLowerCase()
        .split(/\s+/u)
        .map((term) => term.trim())
        .filter(Boolean)
      const likeClauses = terms.map(() => "LOWER(m.content) LIKE ?").join(" AND ") || "1=1"
      const likeOrder = input.sort === "oldest" ? "s.updated_at ASC" : "s.updated_at DESC"
      rows = this.db
        .query(`
          SELECT m.message_id AS id, m.session_id, m.ordinal, m.role, m.content,
                 s.title, s.directory, s.project_root, s.updated_at, 0 AS score
          FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE ${likeClauses} AND m.role IN (${placeholders})
          ORDER BY ${likeOrder}
          LIMIT ?
        `)
        .all(...terms.map((term) => `%${term}%`), ...roles, limit * 20) as typeof rows
    }
    const hits = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      if (!hits.has(row.session_id)) hits.set(row.session_id, row)
      if (hits.size >= limit) break
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
    }))
    return { mode: "discover", query, count: results.length, results }
  }

  read(sessionID: string): UnknownRecord {
    const session = this.db.query("SELECT * FROM sessions WHERE id = ?").get(sessionID) as
      | UnknownRecord
      | null
    if (!session) throw new Error(`Indexed session not found: ${sessionID}`)
    const all = this.db
      .query("SELECT message_id AS id, ordinal, role, content FROM messages WHERE session_id=? ORDER BY ordinal")
      .all(sessionID) as IndexedMessage[]
    const messages = all.length <= 40 ? all : [...all.slice(0, 25), ...all.slice(-15)]
    return {
      mode: "read",
      session_id: sessionID,
      title: session.title,
      directory: session.directory,
      project_root: session.project_root,
      truncated: messages.length !== all.length,
      total_messages: all.length,
      messages,
    }
  }

  scroll(sessionID: string, aroundMessageID: string, window = 5): UnknownRecord {
    const anchor = this.db
      .query("SELECT ordinal FROM messages WHERE session_id=? AND message_id=?")
      .get(sessionID, aroundMessageID) as { ordinal: number } | null
    if (!anchor) throw new Error(`Message ${aroundMessageID} was not found in session ${sessionID}`)
    const safeWindow = Math.max(1, Math.min(20, Math.trunc(window)))
    return {
      mode: "scroll",
      session_id: sessionID,
      around_message_id: aroundMessageID,
      messages: this.window(sessionID, anchor.ordinal, safeWindow, aroundMessageID),
      messages_before: this.countBefore(sessionID, anchor.ordinal),
      messages_after: this.countAfter(sessionID, anchor.ordinal),
    }
  }

  private bookend(sessionID: string, direction: "ASC" | "DESC"): IndexedMessage[] {
    return this.db
      .query(`
        SELECT message_id AS id, ordinal, role, content
        FROM messages
        WHERE session_id=? AND role IN ('user','assistant')
        ORDER BY ordinal ${direction}
        LIMIT 3
      `)
      .all(sessionID) as IndexedMessage[]
  }

  private window(sessionID: string, ordinal: number, size: number, anchorID: string): UnknownRecord[] {
    return (
      this.db
        .query(`
          SELECT message_id AS id, ordinal, role, content
          FROM messages
          WHERE session_id=? AND ordinal BETWEEN ? AND ?
          ORDER BY ordinal
        `)
        .all(sessionID, Math.max(0, ordinal - size), ordinal + size) as IndexedMessage[]
    ).map((message) => ({ ...message, anchor: message.id === anchorID }))
  }

  private countBefore(sessionID: string, ordinal: number): number {
    return Number(
      (this.db.query("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND ordinal<?").get(
        sessionID,
        ordinal,
      ) as { count: number }).count,
    )
  }

  private countAfter(sessionID: string, ordinal: number): number {
    return Number(
      (this.db.query("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND ordinal>?").get(
        sessionID,
        ordinal,
      ) as { count: number }).count,
    )
  }
}

export type PendingPayload =
  | {
      kind: "memory"
      action: "add" | "replace" | "remove"
      target: MemoryTarget
      content?: string
      oldText?: string
    }
  | {
      kind: "skill"
      action: "create" | "update" | "delete"
      name: string
      description?: string
      content?: string
      owner: SkillOwner
      sourceSessionID?: string
      absorbedInto?: string
    }

export interface PendingRecord {
  schemaVersion: 1
  id: string
  summary: string
  origin: "background_review"
  projectRoot: string
  createdAt: string
  payload: PendingPayload
}

function validPending(value: unknown): value is PendingRecord {
  if (!value || typeof value !== "object") return false
  const item = value as UnknownRecord
  return (
    item.schemaVersion === 1 &&
    typeof item.id === "string" &&
    typeof item.summary === "string" &&
    item.origin === "background_review" &&
    typeof item.projectRoot === "string" &&
    typeof item.createdAt === "string" &&
    Boolean(item.payload && typeof item.payload === "object")
  )
}

export class PendingWriteStore {
  readonly root: string
  readonly historyRoot: string

  constructor(dataRoot: string) {
    this.root = join(dataRoot, "pending")
    this.historyRoot = join(this.root, "history")
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.historyRoot, { recursive: true }),
    ])
  }

  async stage(input: Omit<PendingRecord, "schemaVersion" | "id" | "createdAt">): Promise<PendingRecord> {
    await this.ensureLayout()
    const record: PendingRecord = {
      schemaVersion: 1,
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      createdAt: new Date().toISOString(),
      ...input,
    }
    await atomicWriteText(this.recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  async list(): Promise<PendingRecord[]> {
    await this.ensureLayout()
    const names = await readdir(this.root)
    const records = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{12}\.json$/u.test(name))
        .map(async (name) => {
          try {
            const value = JSON.parse(await readFile(join(this.root, name), "utf8")) as unknown
            return validPending(value) ? value : undefined
          } catch {
            return undefined
          }
        }),
    )
    return records
      .filter((record): record is PendingRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async get(id: string): Promise<PendingRecord | undefined> {
    if (!/^[a-f0-9]{12}$/u.test(id)) throw new Error("Invalid pending write id")
    try {
      const value = JSON.parse(await readFile(this.recordPath(id), "utf8")) as unknown
      return validPending(value) ? value : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async approve(id: string, apply: (record: PendingRecord) => Promise<unknown>): Promise<unknown> {
    const record = await this.get(id)
    if (!record) throw new Error(`Pending write not found: ${id}`)
    const processing = join(this.root, `${id}.processing`)
    await rename(this.recordPath(id), processing)
    try {
      const result = await apply(record)
      await atomicWriteText(
        join(this.historyRoot, `${id}.approved.json`),
        `${JSON.stringify({ ...record, resolvedAt: new Date().toISOString(), status: "approved" }, null, 2)}\n`,
      )
      await rm(processing, { force: true })
      return result
    } catch (error) {
      await rename(processing, this.recordPath(id)).catch(() => undefined)
      throw error
    }
  }

  async reject(id: string): Promise<PendingRecord> {
    const record = await this.get(id)
    if (!record) throw new Error(`Pending write not found: ${id}`)
    await atomicWriteText(
      join(this.historyRoot, `${id}.rejected.json`),
      `${JSON.stringify({ ...record, resolvedAt: new Date().toISOString(), status: "rejected" }, null, 2)}\n`,
    )
    await rm(this.recordPath(id), { force: true })
    return record
  }

  private recordPath(id: string): string {
    return join(this.root, `${id}.json`)
  }
}

export interface JourneyEvent {
  id: string
  at: string
  kind: "memory" | "skill" | "pending" | "provider"
  action: string
  label: string
  projectRoot?: string
  sourceSessionID?: string
  metadata?: UnknownRecord
}

type JourneyState = { schemaVersion: 1; events: JourneyEvent[] }

export class LearningJourneyStore {
  readonly path: string
  private readonly dataRoot: string

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot
    this.path = join(dataRoot, "learning-journey.json")
  }

  async append(input: Omit<JourneyEvent, "id" | "at">): Promise<JourneyEvent> {
    const event: JourneyEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
    }
    await withStorageLock(this.dataRoot, async () => {
      const state = await this.readState()
      state.events.push(event)
      if (state.events.length > 5_000) state.events.splice(0, state.events.length - 5_000)
      await atomicWriteText(this.path, `${JSON.stringify(state, null, 2)}\n`)
    })
    return event
  }

  async timeline(limit = 100): Promise<JourneyEvent[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)))
    return (await this.readState()).events.slice(-safeLimit).reverse()
  }

  async graph(store: LearningStore): Promise<UnknownRecord> {
    const [memory, user, project, skills, events] = await Promise.all([
      store.readMemory("memory"),
      store.readMemory("user"),
      store.projectRoot ? store.readMemory("project") : Promise.resolve([]),
      store.listSkills(),
      this.timeline(5_000),
    ])
    const timestamp = (kind: string, label: string) =>
      events.find((event) => event.kind === kind && event.label === label)?.at
    const memories = ([
      ...memory.map((content) => ({ target: "memory" as const, content })),
      ...user.map((content) => ({ target: "user" as const, content })),
      ...project.map((content) => ({ target: "project" as const, content })),
    ]).map((item) => ({
      id: `memory:${item.target}:${shortHash(item.content)}`,
      kind: "memory",
      label: item.content,
      target: item.target,
      timestamp: timestamp("memory", item.content),
    }))
    const skillNodes = skills.map((skill) => ({
      id: `skill:${skill.name}`,
      kind: "skill",
      label: skill.name,
      description: skill.description,
      owner: skill.owner,
      autoManaged: skill.autoManaged,
      timestamp: timestamp("skill", skill.name),
    }))
    const edges: UnknownRecord[] = []
    for (const memoryNode of memories) {
      const memoryTokens = tokens(memoryNode.label)
      const scored = skillNodes
        .map((skill) => ({
          id: skill.id,
          overlap: intersectionSize(memoryTokens, tokens(`${skill.label} ${skill.description}`)),
        }))
        .filter((item) => item.overlap > 0)
        .sort((left, right) => right.overlap - left.overlap)
        .slice(0, 4)
      for (const item of scored) {
        edges.push({ source: memoryNode.id, target: item.id, relation: "related_to", weight: item.overlap })
      }
    }
    const ordered = [...memories, ...skillNodes]
      .filter((node) => node.timestamp)
      .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
    for (let index = 1; index < ordered.length; index += 1) {
      edges.push({ source: ordered[index - 1].id, target: ordered[index].id, relation: "learned_after" })
    }
    return {
      nodes: [...memories, ...skillNodes],
      edges,
      stats: {
        memories: memories.length,
        skills: skillNodes.length,
        edges: edges.length,
        events: events.length,
      },
    }
  }

  private async readState(): Promise<JourneyState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown
      if (!value || typeof value !== "object") return { schemaVersion: 1, events: [] }
      const item = value as UnknownRecord
      if (item.schemaVersion !== 1 || !Array.isArray(item.events)) return { schemaVersion: 1, events: [] }
      return value as JourneyState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, events: [] }
      throw error
    }
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)
}

function tokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase()
  const result = new Set(
    normalized
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )
  const compactCJK = [...normalized].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char))
  for (let index = 0; index + 1 < compactCJK.length; index += 1) {
    result.add(`${compactCJK[index]}${compactCJK[index + 1]}`)
  }
  return result
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const value of left) if (right.has(value)) count += 1
  return count
}

type ExternalResult = { provider: ExternalMemoryProviderName; results: UnknownRecord[] }

export class ExternalMemoryAdapter {
  private honchoClient: unknown

  constructor(
    private readonly config: LearningConfig,
    private readonly projectRoot: string,
  ) {}

  status(): UnknownRecord {
    const provider = this.config.externalMemoryProvider
    const configured =
      provider === "builtin" ||
      (provider === "mem0" && Boolean(process.env.MEM0_API_KEY || process.env.MEM0_HOST)) ||
      (provider === "honcho" && Boolean(process.env.HONCHO_API_KEY || process.env.HONCHO_URL))
    return {
      provider,
      configured,
      autoSync: this.config.externalMemoryAutoSync,
      topK: this.config.externalMemoryTopK,
      timeoutMs: this.config.externalMemoryTimeoutMs,
      credentialSource:
        provider === "mem0"
          ? "MEM0_API_KEY / MEM0_HOST"
          : provider === "honcho"
            ? "HONCHO_API_KEY / HONCHO_URL"
            : "none",
    }
  }

  async search(query: string): Promise<ExternalResult> {
    const provider = this.config.externalMemoryProvider
    if (provider === "builtin") return { provider, results: [] }
    if (provider === "mem0") return { provider, results: await this.searchMem0(query) }
    return { provider, results: await this.searchHoncho(query) }
  }

  async syncTurn(sessionID: string, userContent: string, assistantContent: string): Promise<void> {
    if (!this.config.externalMemoryAutoSync || this.config.externalMemoryProvider === "builtin") return
    if (!userContent.trim() || !assistantContent.trim()) return
    if (this.config.externalMemoryProvider === "mem0") {
      await this.syncMem0(sessionID, userContent, assistantContent)
      return
    }
    await this.syncHoncho(sessionID, userContent, assistantContent)
  }

  private async searchMem0(query: string): Promise<UnknownRecord[]> {
    const host = process.env.MEM0_HOST?.replace(/\/$/u, "")
    const apiKey = process.env.MEM0_API_KEY ?? ""
    if (!host && !apiKey) throw new Error("Mem0 is not configured; set MEM0_API_KEY or MEM0_HOST")
    const userID = process.env.MEM0_USER_ID || "opencode-user"
    const response = await this.requestJSON(
      host ? `${host}/search` : "https://api.mem0.ai/v3/memories/search/",
      host
        ? { query, user_id: userID, agent_id: process.env.MEM0_AGENT_ID || "opencode" }
        : { query, filters: { user_id: userID }, top_k: this.config.externalMemoryTopK },
      host ? { "X-API-Key": apiKey } : { Authorization: `Token ${apiKey}` },
    )
    const raw = Array.isArray(response)
      ? response
      : response && typeof response === "object" && Array.isArray((response as UnknownRecord).results)
        ? ((response as UnknownRecord).results as unknown[])
        : []
    return raw.slice(0, this.config.externalMemoryTopK).map(normalizeExternalItem)
  }

  private async syncMem0(sessionID: string, userContent: string, assistantContent: string): Promise<void> {
    const host = process.env.MEM0_HOST?.replace(/\/$/u, "")
    const apiKey = process.env.MEM0_API_KEY ?? ""
    if (!host && !apiKey) throw new Error("Mem0 is not configured; set MEM0_API_KEY or MEM0_HOST")
    const userID = process.env.MEM0_USER_ID || "opencode-user"
    await this.requestJSON(
      host ? `${host}/memories` : "https://api.mem0.ai/v3/memories/add/",
      {
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: assistantContent },
        ],
        user_id: userID,
        agent_id: process.env.MEM0_AGENT_ID || "opencode",
        run_id: sessionID,
        metadata: { project_root: this.projectRoot, source: "opencode-continuous-learning" },
      },
      host ? { "X-API-Key": apiKey } : { Authorization: `Token ${apiKey}` },
    )
  }

  private async searchHoncho(query: string): Promise<UnknownRecord[]> {
    const client = await this.honcho()
    const user = await client.peer(process.env.HONCHO_USER_ID || "opencode-user")
    const messages = await user.search(query, { limit: this.config.externalMemoryTopK })
    return messages.map((message) => ({
      id: message.id,
      content: message.content,
      session_id: message.sessionId,
      peer_id: message.peerId,
      created_at: message.createdAt,
    }))
  }

  private async syncHoncho(sessionID: string, userContent: string, assistantContent: string): Promise<void> {
    const client = await this.honcho()
    const user = await client.peer(process.env.HONCHO_USER_ID || "opencode-user")
    const assistant = await client.peer(process.env.HONCHO_AGENT_ID || "opencode-assistant")
    const session = await client.session(`opencode-${sessionID}`, { peers: [user, assistant] })
    await session.addMessages([user.message(userContent), assistant.message(assistantContent)])
  }

  private async honcho(): Promise<import("@honcho-ai/sdk").Honcho> {
    if (this.honchoClient) return this.honchoClient as import("@honcho-ai/sdk").Honcho
    const { Honcho } = await import("@honcho-ai/sdk")
    this.honchoClient = new Honcho({
      apiKey: process.env.HONCHO_API_KEY,
      baseURL: process.env.HONCHO_URL,
      workspaceId: process.env.HONCHO_WORKSPACE_ID || "opencode-continuous-learning",
      timeout: this.config.externalMemoryTimeoutMs,
      maxRetries: 1,
    })
    return this.honchoClient as import("@honcho-ai/sdk").Honcho
  }

  private async requestJSON(
    url: string,
    body: UnknownRecord,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.externalMemoryTimeoutMs)
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`External memory request failed (${response.status}): ${text.slice(0, 500)}`)
      return text ? (JSON.parse(text) as unknown) : {}
    } finally {
      clearTimeout(timeout)
    }
  }
}

function normalizeExternalItem(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object") return { value: String(value) }
  const item = value as UnknownRecord
  return {
    id: item.id,
    memory: item.memory ?? item.content ?? item.text,
    score: item.score,
    created_at: item.created_at ?? item.createdAt,
    metadata: item.metadata,
  }
}

export async function applyPendingRecord(
  record: PendingRecord,
  input: { dataRoot: string; skillsRoot: string; config: LearningConfig },
): Promise<unknown> {
  if (!input.config.enabled) throw new Error("Continuous learning is disabled")
  const store = new LearningStore(input.dataRoot, input.skillsRoot, input.config, record.projectRoot)
  await store.ensureLayout()
  const payload = record.payload
  if (payload.kind === "memory") {
    if (payload.action === "add") return store.addMemory(payload.target, payload.content ?? "")
    if (payload.action === "replace") {
      return store.replaceMemory(payload.target, payload.oldText ?? "", payload.content ?? "")
    }
    return store.removeMemory(payload.target, payload.oldText ?? "")
  }
  if (payload.action === "create") {
    return store.createSkill({
      name: payload.name,
      description: payload.description ?? "",
      content: payload.content ?? "",
      owner: payload.owner,
      sourceSessionID: payload.sourceSessionID,
    })
  }
  if (payload.action === "update") {
    return store.updateSkill({
      name: payload.name,
      description: payload.description ?? "",
      content: payload.content ?? "",
      origin: payload.owner,
      sourceSessionID: payload.sourceSessionID,
    })
  }
  return store.deleteSkill({
    name: payload.name,
    origin: payload.owner,
    sourceSessionID: payload.sourceSessionID,
    absorbedInto: payload.absorbedInto,
  })
}
