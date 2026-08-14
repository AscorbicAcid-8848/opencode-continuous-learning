import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  ExternalMemoryAdapter,
  LearningJourneyStore,
  PendingWriteStore,
  SessionSearchStore,
  applyPendingRecord,
} from "../src/advanced.ts"
import { DEFAULT_CONFIG, LearningStore, type TranscriptItem } from "../src/core.ts"

const transcript = (topic: string): TranscriptItem[] => [
  { id: "u1", role: "user", text: `Please investigate ${topic}`, toolCalls: [] },
  {
    id: "a1",
    role: "assistant",
    text: `Resolved ${topic} with a durable fix`,
    toolCalls: [{ name: "read", status: "completed", output: `${topic} details` }],
  },
]

test("session search indexes, discovers, reads, scrolls, browses, and removes sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuous-learning-search-"))
  try {
    const search = new SessionSearchStore(join(root, "sessions.sqlite"))
    search.indexSession(
      {
        id: "session-alpha",
        title: "Authentication refactor",
        directory: "/repo/auth",
        projectRoot: "/repo",
        createdAt: 1,
        updatedAt: 2,
      },
      transcript("token refresh"),
    )
    search.indexSession(
      {
        id: "session-beta",
        title: "Database tuning",
        directory: "/repo/db",
        projectRoot: "/repo",
        createdAt: 3,
        updatedAt: 4,
      },
      transcript("query planner"),
    )

    const discovered = search.search({ query: "token", limit: 3 }) as {
      count: number
      results: Array<{ session_id: string; match_message_id: string }>
    }
    assert.equal(discovered.count, 1)
    assert.equal(discovered.results[0].session_id, "session-alpha")

    const read = search.read("session-alpha") as { total_messages: number }
    assert.equal(read.total_messages, 3)
    const scrolled = search.scroll(
      "session-alpha",
      discovered.results[0].match_message_id,
      2,
    ) as { messages: unknown[] }
    assert.ok(scrolled.messages.length >= 2)
    const browsed = search.browse(10) as { sessions: Array<{ session_id: string }> }
    assert.deepEqual(
      browsed.sessions.map((item) => item.session_id),
      ["session-beta", "session-alpha"],
    )

    assert.equal(search.isExternalTurnSynced("mem0", "session-alpha", "a1"), false)
    search.markExternalTurnSynced("mem0", "session-alpha", "a1")
    assert.equal(search.isExternalTurnSynced("mem0", "session-alpha", "a1"), true)
    assert.equal(search.isExternalTurnSynced("honcho", "session-alpha", "a1"), false)

    search.close()
    const reopened = new SessionSearchStore(join(root, "sessions.sqlite"))
    assert.equal(reopened.isExternalTurnSynced("mem0", "session-alpha", "a1"), true)

    reopened.removeSession("session-alpha")
    assert.throws(() => reopened.read("session-alpha"), /not found/u)
    assert.equal(reopened.isExternalTurnSynced("mem0", "session-alpha", "a1"), false)
    reopened.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("pending writes survive on disk and move to approval or rejection history", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuous-learning-pending-"))
  try {
    const pending = new PendingWriteStore(root)
    const first = await pending.stage({
      summary: "remember project command",
      origin: "background_review",
      projectRoot: "/repo",
      payload: { kind: "memory", action: "add", target: "project", content: "Use bun test" },
    })
    const second = await pending.stage({
      summary: "remove obsolete skill",
      origin: "background_review",
      projectRoot: "/repo",
      payload: {
        kind: "skill",
        action: "delete",
        name: "old-skill",
        owner: "agent",
        absorbedInto: "new-skill",
      },
    })
    assert.deepEqual(
      (await pending.list()).map((item) => item.id),
      [first.id, second.id],
    )
    await assert.rejects(
      applyPendingRecord(first, {
        dataRoot: join(root, "data"),
        skillsRoot: join(root, "skills"),
        config: { ...DEFAULT_CONFIG, enabled: false },
      }),
      /disabled/u,
    )

    const applied = await pending.approve(first.id, async (record) => record.payload.kind)
    assert.equal(applied, "memory")
    await pending.reject(second.id)
    assert.equal((await pending.list()).length, 0)
    assert.match(
      await readFile(join(pending.historyRoot, `${first.id}.approved.json`), "utf8"),
      /"status": "approved"/u,
    )
    assert.match(
      await readFile(join(pending.historyRoot, `${second.id}.rejected.json`), "utf8"),
      /"status": "rejected"/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("journey graph links learned memories and Skills and Skill deletion is recoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuous-learning-journey-"))
  const dataRoot = join(root, "data")
  const skillsRoot = join(root, "skills")
  try {
    const store = new LearningStore(dataRoot, skillsRoot, { ...DEFAULT_CONFIG }, "/repo")
    await store.ensureLayout()
    await store.addMemory("project", "Use token refresh retry logic")
    await store.createSkill({
      name: "token-refresh",
      description: "Debug token refresh retry logic",
      content: "# Token refresh\n\nInspect retries.",
      owner: "agent",
    })
    const journey = new LearningJourneyStore(dataRoot)
    await journey.append({
      kind: "memory",
      action: "add",
      label: "Use token refresh retry logic",
      projectRoot: "/repo",
    })
    await journey.append({
      kind: "skill",
      action: "create",
      label: "token-refresh",
      projectRoot: "/repo",
    })
    await Promise.all([
      journey.append({ kind: "pending", action: "approved", label: "first" }),
      new LearningJourneyStore(dataRoot).append({
        kind: "pending",
        action: "rejected",
        label: "second",
      }),
    ])
    assert.equal((await journey.timeline()).length, 4)
    const graph = (await journey.graph(store)) as {
      nodes: unknown[]
      edges: Array<{ relation: string }>
    }
    assert.equal(graph.nodes.length, 2)
    assert.ok(graph.edges.some((edge) => edge.relation === "related_to"))

    const deleted = await store.deleteSkill({ name: "token-refresh", origin: "agent" })
    assert.equal(deleted.archived, true)
    assert.equal((await store.listSkills()).length, 0)
    assert.match(
      await readFile(join(deleted.archivePath, ".continuous-learning-archive.json"), "utf8"),
      /"name": "token-refresh"/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Mem0 adapter uses official search/add shapes without exposing credentials", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MEM0_API_KEY
  const previousHost = process.env.MEM0_HOST
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  process.env.MEM0_API_KEY = "test-secret-key"
  delete process.env.MEM0_HOST
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(input), body })
    const payload = String(input).includes("search")
      ? { results: [{ id: "m1", memory: "Prefers concise output", score: 0.9 }] }
      : { status: "PENDING", event_id: "event-1" }
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
  try {
    const adapter = new ExternalMemoryAdapter(
      { ...DEFAULT_CONFIG, externalMemoryProvider: "mem0" },
      "/repo",
    )
    const result = await adapter.search("output preference")
    assert.equal(result.results[0].memory, "Prefers concise output")
    await adapter.syncTurn("session-1", "Keep it short", "Understood")
    assert.match(calls[0].url, /\/v3\/memories\/search\/$/u)
    assert.deepEqual(calls[0].body.filters, { user_id: "opencode-user" })
    assert.match(calls[1].url, /\/v3\/memories\/add\/$/u)
    assert.equal(JSON.stringify(adapter.status()).includes("test-secret-key"), false)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MEM0_API_KEY
    else process.env.MEM0_API_KEY = previousKey
    if (previousHost === undefined) delete process.env.MEM0_HOST
    else process.env.MEM0_HOST = previousHost
  }
})
