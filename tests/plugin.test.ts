import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import plugin, { selectProjectRoot } from "../src/plugin.ts"

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for the automatic review")
}

function toolText(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "output" in result && typeof result.output === "string") {
    return result.output
  }
  throw new Error("Expected a textual tool result")
}

test("project scope prefers a containing non-root worktree", () => {
  assert.equal(selectProjectRoot("/workspace/repo/packages/api", "/workspace/repo"), "/workspace/repo")
  assert.equal(selectProjectRoot("/workspace/repo", "/"), "/workspace/repo")
  assert.equal(selectProjectRoot("/workspace/one", "/workspace/two"), "/workspace/one")
})

test("automatic review is isolated and advances its checkpoint only after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-plugin-test-"))
  const dataRoot = join(root, "data")
  const skillsRoot = join(root, "skills")
  const configPath = join(root, "config.json")
  const calls = {
    created: 0,
    deleted: 0,
    promptBody: undefined as Record<string, unknown> | undefined,
  }
  let hooks: Awaited<ReturnType<typeof plugin>>

  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    tool: {
      ids: async () => ({ data: ["read", "bash", "task", "learning_mode"] }),
      list: async () => ({ data: [{ id: "read" }, { id: "webfetch" }] }),
    },
    session: {
      messages: async () => ({
        data: [
          {
            info: {
              id: "user-message",
              role: "user",
              agent: "build",
              model: { providerID: "test-provider", modelID: "test-model" },
            },
            parts: [{ type: "text", text: "Use the verified integration procedure." }],
          },
          {
            info: { id: "assistant-message", role: "assistant" },
            parts: [
              { type: "text", text: "The integration procedure passed." },
              {
                type: "tool",
                tool: "read",
                state: { status: "completed", input: { path: "README.md" }, output: "verified" },
              },
            ],
          },
        ],
      }),
      create: async () => {
        calls.created += 1
        return { data: { id: "review-session" } }
      },
      prompt: async (input: { body: Record<string, unknown> }) => {
        calls.promptBody = input.body
        await hooks.tool!.learning_skill.execute(
          {
            action: "create",
            name: "verified-integration",
            description: "Use when repeating the verified integration procedure.",
            content: "# Verified integration\n\nFollow the procedure recorded in the completed transcript.",
          },
          {
            sessionID: "review-session",
            messageID: "review-message",
            agent: "continuous-learning-review",
            directory: root,
            worktree: root,
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async () => {
              throw new Error("automatic review must not request foreground approval")
            },
          },
        )
        return { data: { info: { time: { completed: Date.now() } } } }
      },
      delete: async () => {
        calls.deleted += 1
        return { data: true }
      },
    },
  }

  try {
    hooks = await plugin(
      { client, directory: root } as never,
      {
        enabled: true,
        configPath,
        dataRoot,
        skillsRoot,
        autoReview: true,
        memoryEveryTurns: 1,
        skillEveryToolCalls: 1,
        retryCooldownMinutes: 1,
        maxConcurrentReviews: 1,
        maxTranscriptChars: 10_000,
        memoryCharLimit: 1_000,
        userCharLimit: 1_000,
        foregroundWriteApproval: true,
        deleteReviewSessions: true,
        showNotifications: false,
      },
    )

    const resolvedConfig: { agent?: Record<string, Record<string, unknown>> } = {}
    await hooks.config!(resolvedConfig as never)
    const reviewer = resolvedConfig.agent?.["continuous-learning-review"]
    assert.equal(reviewer?.steps, 12)
    assert.deepEqual(reviewer?.permission, {
      "*": "deny",
      learning_memory: "allow",
      learning_skill: "allow",
      learning_status: "allow",
      session_search: "deny",
      learning_pending: "deny",
      learning_journey: "deny",
      learning_external_memory: "deny",
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      doom_loop: "deny",
      external_directory: "deny",
    })

    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "source-session" } },
    } as never)
    await waitFor(() => calls.deleted === 1)

    assert.equal(calls.created, 1)
    const promptTools = calls.promptBody?.tools as Record<string, boolean>
    assert.equal(promptTools.read, false)
    assert.equal(promptTools.bash, false)
    assert.equal(promptTools.task, false)
    assert.equal(promptTools.webfetch, false)
    assert.equal(promptTools.learning_memory, true)
    assert.equal(promptTools.learning_skill, true)
    assert.equal(promptTools.learning_status, true)
    assert.equal(promptTools.learning_mode, false)
    const promptParts = calls.promptBody?.parts as Array<{ text?: string }>
    assert.match(promptParts[0]?.text ?? "", /learning_memory target project/)
    assert.match(promptParts[0]?.text ?? "", new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))

    const provenance = JSON.parse(
      await readFile(join(dataRoot, "skill-provenance", "verified-integration.json"), "utf8"),
    ) as { owner: string; autoManaged: boolean }
    assert.equal(provenance.owner, "agent")
    assert.equal(provenance.autoManaged, true)

    const state = JSON.parse(await readFile(join(dataRoot, "review-state.json"), "utf8")) as {
      sessions: Record<
        string,
        {
          userTurns: number
          toolCalls: number
          lastAttemptAt?: string
          lastSuccessAt?: string
          lastMessageID?: string
        }
      >
    }
    const checkpoint = state.sessions["source-session"]
    assert.equal(checkpoint.userTurns, 1)
    assert.equal(checkpoint.toolCalls, 1)
    assert.equal(checkpoint.lastMessageID, "assistant-message")
    assert.equal(typeof checkpoint.lastAttemptAt, "string")
    assert.equal(typeof checkpoint.lastSuccessAt, "string")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("master switch immediately disables injection, reviews, and learning tools while preserving control", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-mode-test-"))
  const configPath = join(root, "config.json")
  let messageReads = 0
  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    session: {
      messages: async () => {
        messageReads += 1
        return { data: [] }
      },
    },
  }
  const context = {
    sessionID: "foreground-session",
    messageID: "foreground-message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }

  try {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          enabled: false,
          autoReview: false,
          foregroundWriteApproval: false,
          futureSetting: "preserved",
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    const hooks = await plugin(
      { client, directory: root } as never,
      {
        configPath,
        dataRoot: join(root, "data"),
        skillsRoot: join(root, "skills"),
      },
    )

    const disabledSystem = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "foreground-session" } as never,
      disabledSystem,
    )
    assert.deepEqual(disabledSystem.system, [])

    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "foreground-session" } },
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(messageReads, 0)

    await assert.rejects(
      hooks.tool!.learning_memory.execute({ action: "view", target: "memory" }, context),
      /mode is disabled/,
    )
    const initial = JSON.parse(
      toolText(await hooks.tool!.learning_mode.execute({ action: "status" }, context)),
    ) as { enabled: boolean; changed: boolean }
    assert.equal(initial.enabled, false)
    assert.equal(initial.changed, false)

    const enabled = JSON.parse(
      toolText(await hooks.tool!.learning_mode.execute({ action: "on" }, context)),
    ) as { enabled: boolean; changed: boolean }
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.changed, true)
    const persistedOn = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>
    assert.equal(persistedOn.enabled, true)
    assert.equal(persistedOn.futureSetting, "preserved")

    const enabledSystem = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "foreground-session" } as never,
      enabledSystem,
    )
    assert.equal(enabledSystem.system.length, 1)
    assert.match(enabledSystem.system[0], /<persistent-learning-snapshot>/)
    assert.match(
      toolText(await hooks.tool!.learning_memory.execute({ action: "view", target: "memory" }, context)),
      /"entries": \[\]/,
    )
    await hooks.tool!.learning_memory.execute(
      { action: "add", target: "project", content: "This project uses a scoped memory entry." },
      context,
    )
    const projectMemory = JSON.parse(
      toolText(await hooks.tool!.learning_memory.execute({ action: "view", target: "project" }, context)),
    ) as { entries: string[] }
    assert.deepEqual(projectMemory.entries, ["This project uses a scoped memory entry."])

    await writeFile(
      configPath,
      `${JSON.stringify({ ...persistedOn, memoryContextEnabled: false }, null, 2)}\n`,
      "utf8",
    )
    const memoryContextDisabledSystem = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "foreground-session" } as never,
      memoryContextDisabledSystem,
    )
    assert.deepEqual(memoryContextDisabledSystem.system, [])
    assert.match(
      toolText(await hooks.tool!.learning_memory.execute({ action: "view", target: "memory" }, context)),
      /"entries": \[\]/,
    )

    await writeFile(
      configPath,
      `${JSON.stringify({ ...persistedOn, enabled: false }, null, 2)}\n`,
      "utf8",
    )
    const externallyDisabledSystem = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "foreground-session" } as never,
      externallyDisabledSystem,
    )
    assert.deepEqual(externallyDisabledSystem.system, [])
    const externallyDisabled = JSON.parse(
      toolText(await hooks.tool!.learning_mode.execute({ action: "status" }, context)),
    ) as { enabled: boolean }
    assert.equal(externallyDisabled.enabled, false)

    await writeFile(
      configPath,
      `${JSON.stringify({ ...persistedOn, enabled: true }, null, 2)}\n`,
      "utf8",
    )

    const disabled = JSON.parse(
      toolText(await hooks.tool!.learning_mode.execute({ action: "off" }, context)),
    ) as { enabled: boolean; changed: boolean }
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.changed, true)
    const disabledAgainSystem = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "foreground-session" } as never,
      disabledAgainSystem,
    )
    assert.deepEqual(disabledAgainSystem.system, [])
    assert.equal((JSON.parse(await readFile(configPath, "utf8")) as { enabled: boolean }).enabled, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("background approval stages automatic writes and foreground approval safely applies them", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuous-learning-approval-"))
  const dataRoot = join(root, "data")
  const skillsRoot = join(root, "skills")
  const configPath = join(root, "config.json")
  let hooks = undefined as Awaited<ReturnType<typeof plugin>> | undefined
  let deleted = 0
  const messages = [
    {
      info: {
        id: "u1",
        role: "user",
        model: { providerID: "test-provider", modelID: "test-model" },
      },
      parts: [{ type: "text", text: "Remember that this project uses bun test" }],
    },
    {
      info: { id: "a1", role: "assistant" },
      parts: [{ type: "text", text: "Done" }],
    },
  ]
  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    tool: {
      ids: async () => ({ data: ["read", "learning_memory"] }),
      list: async () => ({ data: [{ id: "read" }, { id: "learning_memory" }] }),
    },
    session: {
      messages: async () => ({ data: messages }),
      create: async () => ({ data: { id: "approval-review" } }),
      prompt: async () => {
        await hooks!.tool!.learning_memory.execute(
          { action: "add", target: "project", content: "Use bun test for this project" },
          {
            sessionID: "approval-review",
            messageID: "review-message",
            agent: "continuous-learning-review",
            directory: root,
            worktree: root,
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async () => {
              throw new Error("background writes must not ask inline")
            },
          },
        )
        return { data: { info: { time: { completed: Date.now() } } } }
      },
      delete: async () => {
        deleted += 1
        return { data: true }
      },
    },
  }
  const context = {
    sessionID: "source-session",
    messageID: "foreground-message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }

  try {
    hooks = await plugin(
      { client: client as never, directory: root, worktree: root } as never,
      {
        configPath,
        dataRoot,
        skillsRoot,
        memoryEveryTurns: 1,
        skillEveryToolCalls: 100,
        backgroundWriteApproval: true,
        foregroundWriteApproval: false,
        showNotifications: false,
      },
    )
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "source-session" } },
    } as never)
    await waitFor(() => deleted === 1)

    const pending = JSON.parse(
      toolText(await hooks.tool!.learning_pending.execute({ action: "list" }, context)),
    ) as Array<{ id: string; payload: { kind: string } }>
    assert.equal(pending.length, 1)
    assert.equal(pending[0].payload.kind, "memory")

    await hooks.tool!.learning_pending.execute(
      { action: "approve", id: pending[0].id },
      context,
    )
    const memory = JSON.parse(
      toolText(
        await hooks.tool!.learning_memory.execute(
          { action: "view", target: "project" },
          context,
        ),
      ),
    ) as { entries: string[] }
    assert.deepEqual(memory.entries, ["Use bun test for this project"])
    assert.equal(
      (JSON.parse(toolText(await hooks.tool!.learning_pending.execute({ action: "list" }, context))) as unknown[])
        .length,
      0,
    )
  } finally {
    await hooks?.dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("dispose waits for an in-flight automatic review before closing", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-dispose-"))
  const dataRoot = join(root, "data")
  const skillsRoot = join(root, "skills")
  const configPath = join(root, "config.json")
  let hooks = undefined as Awaited<ReturnType<typeof plugin>> | undefined
  let releasePrompt: (() => void) | undefined
  const messages = [
    {
      info: { id: "u1", role: "user", model: { providerID: "p", modelID: "m" } },
      parts: [{ type: "text", text: "Remember to wait for dispose" }],
    },
    {
      info: { id: "a1", role: "assistant" },
      parts: [{ type: "text", text: "Done" }],
    },
  ]
  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    tool: {
      ids: async () => ({ data: [] }),
      list: async () => ({ data: [] }),
    },
    session: {
      get: async () => ({ data: { id: "source-session", directory: root, time: {} } }),
      messages: async () => ({ data: messages }),
      create: async () => ({ data: { id: "review-dispose" } }),
      prompt: async () => {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve
        })
        return { data: { info: { time: { completed: Date.now() } } } }
      },
      delete: async () => ({ data: true }),
    },
  }

  try {
    hooks = await plugin(
      { client: client as never, directory: root, worktree: root } as never,
      {
        configPath,
        dataRoot,
        skillsRoot,
        memoryEveryTurns: 1,
        skillEveryToolCalls: 100,
        maxConcurrentReviews: 1,
        deleteReviewSessions: true,
        showNotifications: false,
      },
    )
    await hooks.event!({
      event: { type: "session.idle", properties: { sessionID: "source-session" } },
    } as never)
    await waitFor(() => typeof releasePrompt === "function")

    let disposeResolved = false
    const disposePromise = hooks.dispose!().then(() => {
      disposeResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(disposeResolved, false)

    releasePrompt!()
    await disposePromise
    assert.equal(disposeResolved, true)
  } finally {
    releasePrompt?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("session_search backfills an OpenCode session and returns full-text matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuous-learning-session-search-"))
  let hooks = undefined as Awaited<ReturnType<typeof plugin>> | undefined
  const client = {
    app: { log: async () => ({ data: true }) },
    tui: { showToast: async () => ({ data: true }) },
    session: {
      list: async () => ({
        data: [
          {
            id: "historical-session",
            title: "Quartz regression",
            directory: root,
            time: { created: 1, updated: 2 },
          },
        ],
      }),
      messages: async () => ({
        data: [
          {
            info: { id: "history-user", role: "user" },
            parts: [{ type: "text", text: "Investigate the quartz scheduler regression" }],
          },
          {
            info: { id: "history-assistant", role: "assistant" },
            parts: [{ type: "text", text: "The quartz scheduler fix was verified" }],
          },
        ],
      }),
    },
  }
  const context = {
    sessionID: "foreground-session",
    messageID: "foreground-message",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }

  try {
    hooks = await plugin(
      { client: client as never, directory: root, worktree: root } as never,
      {
        configPath: join(root, "config.json"),
        dataRoot: join(root, "data"),
        skillsRoot: join(root, "skills"),
        autoReview: false,
        showNotifications: false,
      },
    )
    const result = JSON.parse(
      toolText(await hooks.tool!.session_search.execute({ query: "quartz" }, context)),
    ) as { count: number; results: Array<{ session_id: string }> }
    assert.equal(result.count, 1)
    assert.equal(result.results[0].session_id, "historical-session")
  } finally {
    await hooks?.dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
