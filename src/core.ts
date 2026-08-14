import { createHash, randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { homedir, hostname } from "node:os"

export type MemoryTarget = "memory" | "user" | "project"
export type SkillOwner = "user" | "agent"
export type ExternalMemoryProviderName = "builtin" | "mem0" | "honcho"

export interface LearningConfig {
  enabled: boolean
  memoryContextEnabled: boolean
  autoReview: boolean
  sessionSearchMaxSessions: number
  backgroundWriteApproval: boolean
  externalMemoryProvider: ExternalMemoryProviderName
  externalMemoryAutoSync: boolean
  externalMemoryTopK: number
  externalMemoryTimeoutMs: number
  memoryEveryTurns: number
  skillEveryToolCalls: number
  retryCooldownMinutes: number
  maxConcurrentReviews: number
  maxTranscriptChars: number
  memoryCharLimit: number
  projectMemoryCharLimit: number
  userCharLimit: number
  foregroundWriteApproval: boolean
  deleteReviewSessions: boolean
  showNotifications: boolean
}

export const DEFAULT_CONFIG: LearningConfig = {
  enabled: true,
  memoryContextEnabled: true,
  autoReview: true,
  sessionSearchMaxSessions: 200,
  backgroundWriteApproval: false,
  externalMemoryProvider: "builtin",
  externalMemoryAutoSync: true,
  externalMemoryTopK: 5,
  externalMemoryTimeoutMs: 3_000,
  memoryEveryTurns: 10,
  skillEveryToolCalls: 15,
  retryCooldownMinutes: 30,
  maxConcurrentReviews: 2,
  maxTranscriptChars: 60_000,
  memoryCharLimit: 2_200,
  projectMemoryCharLimit: 4_000,
  userCharLimit: 1_375,
  foregroundWriteApproval: true,
  deleteReviewSessions: true,
  showNotifications: true,
}

export type LearningConfigKey = keyof LearningConfig

export type LearningConfigFieldSpec =
  | { kind: "boolean"; default: boolean }
  | { kind: "integer"; default: number; minimum: number; maximum: number }
  | { kind: "enum"; default: string; values: readonly string[] }

export const CONFIG_FIELD_SPECS: Record<LearningConfigKey, LearningConfigFieldSpec> = {
  enabled: { kind: "boolean", default: DEFAULT_CONFIG.enabled },
  memoryContextEnabled: { kind: "boolean", default: DEFAULT_CONFIG.memoryContextEnabled },
  autoReview: { kind: "boolean", default: DEFAULT_CONFIG.autoReview },
  sessionSearchMaxSessions: {
    kind: "integer",
    default: DEFAULT_CONFIG.sessionSearchMaxSessions,
    minimum: 10,
    maximum: 2_000,
  },
  backgroundWriteApproval: {
    kind: "boolean",
    default: DEFAULT_CONFIG.backgroundWriteApproval,
  },
  externalMemoryProvider: {
    kind: "enum",
    default: DEFAULT_CONFIG.externalMemoryProvider,
    values: ["builtin", "mem0", "honcho"],
  },
  externalMemoryAutoSync: {
    kind: "boolean",
    default: DEFAULT_CONFIG.externalMemoryAutoSync,
  },
  externalMemoryTopK: {
    kind: "integer",
    default: DEFAULT_CONFIG.externalMemoryTopK,
    minimum: 1,
    maximum: 50,
  },
  externalMemoryTimeoutMs: {
    kind: "integer",
    default: DEFAULT_CONFIG.externalMemoryTimeoutMs,
    minimum: 500,
    maximum: 30_000,
  },
  memoryEveryTurns: {
    kind: "integer",
    default: DEFAULT_CONFIG.memoryEveryTurns,
    minimum: 1,
    maximum: 1_000,
  },
  skillEveryToolCalls: {
    kind: "integer",
    default: DEFAULT_CONFIG.skillEveryToolCalls,
    minimum: 1,
    maximum: 10_000,
  },
  retryCooldownMinutes: {
    kind: "integer",
    default: DEFAULT_CONFIG.retryCooldownMinutes,
    minimum: 1,
    maximum: 24 * 60,
  },
  maxConcurrentReviews: {
    kind: "integer",
    default: DEFAULT_CONFIG.maxConcurrentReviews,
    minimum: 1,
    maximum: 8,
  },
  maxTranscriptChars: {
    kind: "integer",
    default: DEFAULT_CONFIG.maxTranscriptChars,
    minimum: 4_000,
    maximum: 500_000,
  },
  memoryCharLimit: {
    kind: "integer",
    default: DEFAULT_CONFIG.memoryCharLimit,
    minimum: 500,
    maximum: 100_000,
  },
  projectMemoryCharLimit: {
    kind: "integer",
    default: DEFAULT_CONFIG.projectMemoryCharLimit,
    minimum: 500,
    maximum: 100_000,
  },
  userCharLimit: {
    kind: "integer",
    default: DEFAULT_CONFIG.userCharLimit,
    minimum: 500,
    maximum: 100_000,
  },
  foregroundWriteApproval: {
    kind: "boolean",
    default: DEFAULT_CONFIG.foregroundWriteApproval,
  },
  deleteReviewSessions: {
    kind: "boolean",
    default: DEFAULT_CONFIG.deleteReviewSessions,
  },
  showNotifications: { kind: "boolean", default: DEFAULT_CONFIG.showNotifications },
}

export const CONFIG_FIELD_KEYS = Object.keys(CONFIG_FIELD_SPECS) as LearningConfigKey[]

const RETIRED_CONFIG_FIELDS = [
  "sessionSearchEnabled",
  "learningJourneyEnabled",
  "skillDeleteEnabled",
] as const

export interface SkillProvenance {
  schemaVersion: 1
  name: string
  owner: SkillOwner
  autoManaged: boolean
  contentHash: string
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  sourceSessionID?: string
}

export interface SkillSummary {
  name: string
  description: string
  path: string
  owner: SkillOwner
  autoManaged: boolean
}

export interface ReviewCheckpoint {
  userTurns: number
  toolCalls: number
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  lastMessageID?: string
}

export interface ReviewState {
  schemaVersion: 1
  sessions: Record<string, ReviewCheckpoint>
}

export interface TranscriptItem {
  id: string
  role: "user" | "assistant"
  text: string
  toolCalls: Array<{
    name: string
    status: string
    input?: unknown
    output?: string
  }>
}

const MEMORY_HEADERS: Record<MemoryTarget, string> = {
  memory: "# Persistent Memory",
  user: "# User Profile",
  project: "# Project Memory",
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
const THREAT_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|prompts)/iu,
  /(?:reveal|print|exfiltrate)[\s\S]{0,48}(?:system\s+prompt|password|secret|token|api\s*key)/iu,
  /(?:send|upload|exfiltrate)[\s\S]{0,48}(?:password|secret|token|api\s*key)/iu,
  /\b(?:sk|rk|pk)-[a-z0-9_-]{16,}\b/iu,
  /\bgh[opusr]_[a-z0-9]{20,}\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /<\/persistent-learning-snapshot\s*>/iu,
  /[\u202a-\u202e\u2066-\u2069]/u,
]

// The server stores its durable data under the OpenCode data directory
// (typically `~/.local/share/opencode`). The TUI plugin API does not expose that
// path, so both sides must derive the same root from the same helper instead of
// the TUI accidentally using the XDG state directory.
export function defaultDataRoot(): string {
  return join(homedir(), ".local", "share", "opencode", "continuous-learning")
}

function nowISO(): string {
  return new Date().toISOString()
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

function asEnum<T extends string>(value: unknown, fallback: T, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback
}

export function normalizeConfig(value: unknown): LearningConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    enabled: asBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
    memoryContextEnabled: asBoolean(
      raw.memoryContextEnabled,
      DEFAULT_CONFIG.memoryContextEnabled,
    ),
    autoReview: asBoolean(raw.autoReview, DEFAULT_CONFIG.autoReview),
    sessionSearchMaxSessions: asInteger(
      raw.sessionSearchMaxSessions,
      DEFAULT_CONFIG.sessionSearchMaxSessions,
      10,
      2_000,
    ),
    backgroundWriteApproval: asBoolean(
      raw.backgroundWriteApproval,
      DEFAULT_CONFIG.backgroundWriteApproval,
    ),
    externalMemoryProvider: asEnum(
      raw.externalMemoryProvider,
      DEFAULT_CONFIG.externalMemoryProvider,
      ["builtin", "mem0", "honcho"],
    ),
    externalMemoryAutoSync: asBoolean(
      raw.externalMemoryAutoSync,
      DEFAULT_CONFIG.externalMemoryAutoSync,
    ),
    externalMemoryTopK: asInteger(
      raw.externalMemoryTopK,
      DEFAULT_CONFIG.externalMemoryTopK,
      1,
      50,
    ),
    externalMemoryTimeoutMs: asInteger(
      raw.externalMemoryTimeoutMs,
      DEFAULT_CONFIG.externalMemoryTimeoutMs,
      500,
      30_000,
    ),
    memoryEveryTurns: asInteger(raw.memoryEveryTurns, DEFAULT_CONFIG.memoryEveryTurns, 1, 1_000),
    skillEveryToolCalls: asInteger(
      raw.skillEveryToolCalls,
      DEFAULT_CONFIG.skillEveryToolCalls,
      1,
      10_000,
    ),
    retryCooldownMinutes: asInteger(
      raw.retryCooldownMinutes,
      DEFAULT_CONFIG.retryCooldownMinutes,
      1,
      24 * 60,
    ),
    maxConcurrentReviews: asInteger(
      raw.maxConcurrentReviews,
      DEFAULT_CONFIG.maxConcurrentReviews,
      1,
      8,
    ),
    maxTranscriptChars: asInteger(
      raw.maxTranscriptChars,
      DEFAULT_CONFIG.maxTranscriptChars,
      4_000,
      500_000,
    ),
    memoryCharLimit: asInteger(
      raw.memoryCharLimit,
      DEFAULT_CONFIG.memoryCharLimit,
      500,
      100_000,
    ),
    projectMemoryCharLimit: asInteger(
      raw.projectMemoryCharLimit,
      DEFAULT_CONFIG.projectMemoryCharLimit,
      500,
      100_000,
    ),
    userCharLimit: asInteger(
      raw.userCharLimit,
      DEFAULT_CONFIG.userCharLimit,
      500,
      100_000,
    ),
    foregroundWriteApproval: asBoolean(
      raw.foregroundWriteApproval,
      DEFAULT_CONFIG.foregroundWriteApproval,
    ),
    deleteReviewSessions: asBoolean(
      raw.deleteReviewSessions,
      DEFAULT_CONFIG.deleteReviewSessions,
    ),
    showNotifications: asBoolean(raw.showNotifications, DEFAULT_CONFIG.showNotifications),
  }
}

export async function loadConfig(path: string): Promise<LearningConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return DEFAULT_CONFIG
    throw new Error(`Unable to read learning config ${path}: ${String(error)}`)
  }
}

export function validateConfigValue(
  key: LearningConfigKey,
  value: unknown,
): LearningConfig[LearningConfigKey] {
  const spec = CONFIG_FIELD_SPECS[key]
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${key} must be true or false`)
    return value as LearningConfig[LearningConfigKey]
  }
  if (spec.kind === "enum") {
    if (typeof value !== "string" || !spec.values.includes(value)) {
      throw new Error(`${key} must be one of: ${spec.values.join(", ")}`)
    }
    return value as LearningConfig[LearningConfigKey]
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`)
  }
  if (value < spec.minimum || value > spec.maximum) {
    throw new Error(`${key} must be between ${spec.minimum} and ${spec.maximum}`)
  }
  return value
}

export async function updateConfig(
  path: string,
  patch: Partial<LearningConfig>,
): Promise<LearningConfig> {
  let raw: Record<string, unknown> = {}
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object")
    }
    raw = value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Unable to update learning config ${path}: ${String(error)}`)
    }
  }
  for (const key of RETIRED_CONFIG_FIELDS) delete raw[key]
  for (const [rawKey, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELD_SPECS, rawKey)) {
      throw new Error(`Unknown learning config field: ${rawKey}`)
    }
    const key = rawKey as LearningConfigKey
    raw[key] = validateConfigValue(key, value)
  }
  await atomicWriteText(path, `${JSON.stringify(raw, null, 2)}\n`)
  return normalizeConfig(raw)
}

export async function pruneRetiredConfigFields(path: string): Promise<boolean> {
  let raw: Record<string, unknown>
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object")
    }
    raw = value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new Error(`Unable to migrate learning config ${path}: ${String(error)}`)
  }
  let changed = false
  for (const key of RETIRED_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    delete raw[key]
    changed = true
  }
  if (changed) await atomicWriteText(path, `${JSON.stringify(raw, null, 2)}\n`)
  return changed
}

export async function resetConfig(path: string): Promise<LearningConfig> {
  return updateConfig(path, DEFAULT_CONFIG)
}

export async function setConfigEnabled(path: string, enabled: boolean): Promise<void> {
  await updateConfig(path, { enabled })
}

export async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.${path.split(/[\\/]/).at(-1)}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, "wx")
    await handle.writeFile(content, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path)
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 5 || !["EACCES", "EBUSY", "EPERM"].includes(code ?? "")) throw error
        await sleep(25 * (attempt + 1))
      }
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function createTextExclusive(path: string, content: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(path, "wx")
    created = true
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

interface StorageLockInfo {
  owner: string
  pid: number
  host: string
  createdAt: number
}

// A lease long enough to cover any single serialized write, but short enough that
// a lock left behind by a crashed one-shot `opencode run` is reclaimed promptly.
const STORAGE_LOCK_LEASE_MS = 30_000

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user; treat it as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function parseLockInfo(contents: string): StorageLockInfo | undefined {
  const trimmed = contents.trim()
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>
      if (
        typeof value.owner === "string" &&
        typeof value.pid === "number" &&
        typeof value.host === "string" &&
        typeof value.createdAt === "number"
      ) {
        return {
          owner: value.owner,
          pid: value.pid,
          host: value.host,
          createdAt: value.createdAt,
        }
      }
    } catch {
      // Fall through to the legacy text format below.
    }
  }
  // Legacy format: `<pid>:<uuid>\n<ISO timestamp>\n`.
  const lines = contents.replace(/\r\n/gu, "\n").split("\n")
  const owner = lines[0]?.trim()
  if (!owner) return undefined
  const pid = Number(/^(\d+):/u.exec(owner)?.[1] ?? Number.NaN)
  const createdAt = Date.parse(lines[1] ?? "")
  return {
    owner,
    pid,
    host: "",
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  }
}

function isStaleLock(info: StorageLockInfo, now: number, localHost: string): boolean {
  if (info.host === localHost) return !isProcessAlive(info.pid)
  if (info.host) return info.createdAt > 0 && now - info.createdAt >= STORAGE_LOCK_LEASE_MS
  // Legacy locks carried no host. Trust the local PID when one is recorded;
  // otherwise fall back to the creation-time lease.
  if (Number.isInteger(info.pid) && info.pid > 0) return !isProcessAlive(info.pid)
  return info.createdAt > 0 ? now - info.createdAt >= STORAGE_LOCK_LEASE_MS : true
}

async function readLockInfo(lockPath: string): Promise<StorageLockInfo | undefined> {
  try {
    return parseLockInfo(await readFile(lockPath, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function reclaimStaleLock(lockPath: string, observed: StorageLockInfo): Promise<boolean> {
  const current = await readLockInfo(lockPath)
  if (!current) return true
  // Re-read before deleting: only remove the exact lock we observed, never a lock
  // another process created in the meantime.
  if (current.owner !== observed.owner || current.createdAt !== observed.createdAt) return false
  await rm(lockPath, { force: true })
  return true
}

export async function withStorageLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true })
  const lockPath = join(root, ".write.lock")
  const deadline = Date.now() + 8_000
  const localHost = hostname()
  const owner = `${process.pid}:${randomUUID()}`
  const lockInfo: StorageLockInfo = {
    owner,
    pid: process.pid,
    host: localHost,
    createdAt: Date.now(),
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined

  while (!handle) {
    try {
      handle = await open(lockPath, "wx")
      try {
        await handle.writeFile(`${JSON.stringify(lockInfo)}\n`, "utf8")
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => undefined)
        handle = undefined
        await rm(lockPath, { force: true }).catch(() => undefined)
        throw error
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const observed = await readLockInfo(lockPath)
      if (observed && isStaleLock(observed, Date.now(), localHost)) {
        if (await reclaimStaleLock(lockPath, observed)) continue
      }
      if (Date.now() >= deadline) throw new Error("Persistent learning storage is busy")
      await sleep(40)
    }
  }

  try {
    return await action()
  } finally {
    await handle.close().catch(() => undefined)
    try {
      const contents = await readFile(lockPath, "utf8")
      if (parseLockInfo(contents)?.owner === owner) await rm(lockPath, { force: true })
    } catch {
      // A missing or externally replaced lock must not be removed blindly.
    }
  }
}

function normalizeOneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

function assertSafePersistentText(value: string, label: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim()
  if (!normalized) throw new Error(`${label} cannot be empty`)
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`${label} was rejected by the persistent-content safety scan`)
    }
  }
  return normalized
}

function renderMemory(target: MemoryTarget, entries: string[]): string {
  const body = entries.map((entry) => `- ${normalizeOneLine(entry)}`).join("\n")
  return `${MEMORY_HEADERS[target]}\n\n<!-- Managed by opencode-continuous-learning. One durable fact per line. -->\n${body}${body ? "\n" : ""}`
}

function parseMemory(raw: string, target: MemoryTarget): string[] {
  const lines = raw.replace(/\r\n/gu, "\n").split("\n")
  if (lines[0] !== MEMORY_HEADERS[target]) {
    throw new Error(`${target} file is not in the managed format; refusing to overwrite it`)
  }
  const entries: string[] = []
  for (const line of lines.slice(1)) {
    if (!line || line === "<!-- Managed by opencode-continuous-learning. One durable fact per line. -->") {
      continue
    }
    if (!line.startsWith("- ") || !line.slice(2).trim()) {
      throw new Error(`${target} file contains unmanaged content; refusing to overwrite it`)
    }
    entries.push(line.slice(2).trim())
  }
  return entries
}

function assertSkillName(name: string): string {
  const normalized = name.trim()
  if (normalized.length > 64 || !NAME_PATTERN.test(normalized) || WINDOWS_RESERVED_NAME.test(normalized)) {
    throw new Error("Skill name must be 1-64 lowercase letters, digits, and single hyphens")
  }
  return normalized
}

function normalizeDescription(description: string): string {
  const normalized = normalizeOneLine(assertSafePersistentText(description, "Skill description"))
  if (normalized.length > 500) throw new Error("Skill description must be at most 500 characters")
  return normalized
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/gu, "\n").trim()
  if (!normalized.startsWith("---\n")) return normalized
  const end = normalized.indexOf("\n---\n", 4)
  return end === -1 ? normalized : normalized.slice(end + 5).trim()
}

function renderSkill(name: string, description: string, content: string): string {
  const body = stripFrontmatter(assertSafePersistentText(content, "Skill content"))
  if (body.length > 100_000) throw new Error("Skill content must be at most 100,000 characters")
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`
}

function decodeYAMLScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.replace(/^"|"$/gu, "")
    }
  }
  return trimmed.replace(/^['"]|['"]$/gu, "")
}

function parseSkillHeader(raw: string): { name: string; description: string } | undefined {
  if (!raw.startsWith("---")) return undefined
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return undefined
  const header = raw.slice(3, end)
  const name = /^name:\s*(.+)$/imu.exec(header)?.[1]
  const description = /^description:\s*(.+)$/imu.exec(header)?.[1]
  if (!name || !description) return undefined
  return { name: decodeYAMLScalar(name), description: decodeYAMLScalar(description) }
}

async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw error
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relation = relative(left, right)
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
}

export function projectStorageName(projectRoot: string): string {
  const root = resolve(projectRoot)
  const label = basename(root)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40)
    .toLocaleLowerCase() || "project"
  const hash = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 16)
  return `${label}-${hash}`
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink or junction: ${path}`)
  }
}

function validProvenance(value: unknown, name: string): value is SkillProvenance {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    item.schemaVersion === 1 &&
    item.name === name &&
    (item.owner === "user" || item.owner === "agent") &&
    typeof item.autoManaged === "boolean" &&
    typeof item.contentHash === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(item.contentHash) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  )
}

export class LearningStore {
  readonly dataRoot: string
  readonly skillsRoot: string
  readonly config: LearningConfig
  readonly memoryPath: string
  readonly userPath: string
  readonly projectRoot?: string
  readonly projectsRoot: string
  readonly projectMemoryPath?: string
  readonly reviewStatePath: string
  readonly provenanceRoot: string
  readonly skillArchiveRoot: string

  constructor(
    dataRoot: string,
    skillsRoot: string,
    config: LearningConfig,
    projectRoot?: string,
  ) {
    if (!isAbsolute(dataRoot) || !isAbsolute(skillsRoot)) {
      throw new Error("Persistent learning dataRoot and skillsRoot must be absolute paths")
    }
    this.dataRoot = resolve(dataRoot)
    this.skillsRoot = resolve(skillsRoot)
    if (pathsOverlap(this.dataRoot, this.skillsRoot) || pathsOverlap(this.skillsRoot, this.dataRoot)) {
      throw new Error("Persistent learning dataRoot and skillsRoot must not overlap")
    }
    this.config = config
    this.memoryPath = join(this.dataRoot, "MEMORY.md")
    this.userPath = join(this.dataRoot, "USER.md")
    this.projectRoot = projectRoot ? resolve(projectRoot) : undefined
    this.projectsRoot = join(this.dataRoot, "projects")
    this.projectMemoryPath = this.projectRoot
      ? join(this.projectsRoot, projectStorageName(this.projectRoot), "MEMORY.md")
      : undefined
    this.reviewStatePath = join(this.dataRoot, "review-state.json")
    this.provenanceRoot = join(this.dataRoot, "skill-provenance")
    this.skillArchiveRoot = join(this.skillsRoot, ".continuous-learning-archive")
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.dataRoot, { recursive: true }),
      mkdir(this.skillsRoot, { recursive: true }),
      mkdir(this.provenanceRoot, { recursive: true }),
      mkdir(this.projectsRoot, { recursive: true }),
      mkdir(this.skillArchiveRoot, { recursive: true }),
      this.projectMemoryPath ? mkdir(dirname(this.projectMemoryPath), { recursive: true }) : Promise.resolve(),
    ])
    await Promise.all([
      assertPlainDirectory(this.dataRoot, "dataRoot"),
      assertPlainDirectory(this.skillsRoot, "skillsRoot"),
      assertPlainDirectory(this.provenanceRoot, "provenanceRoot"),
      assertPlainDirectory(this.projectsRoot, "projectsRoot"),
      assertPlainDirectory(this.skillArchiveRoot, "skillArchiveRoot"),
      this.projectMemoryPath
        ? assertPlainDirectory(dirname(this.projectMemoryPath), "project memory directory")
        : Promise.resolve(),
    ])
  }

  private memoryFile(target: MemoryTarget): string {
    if (target === "memory") return this.memoryPath
    if (target === "user") return this.userPath
    if (!this.projectMemoryPath) throw new Error("No project scope is active for project memory")
    return this.projectMemoryPath
  }

  async readMemory(target: MemoryTarget): Promise<string[]> {
    try {
      return parseMemory(await readFile(this.memoryFile(target), "utf8"), target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  async addMemory(target: MemoryTarget, content: string): Promise<{ changed: boolean; entries: string[] }> {
    const safe = normalizeOneLine(assertSafePersistentText(content, "Memory entry"))
    return withStorageLock(this.dataRoot, async () => {
      const entries = await this.readMemory(target)
      if (entries.some((entry) => entry.toLocaleLowerCase() === safe.toLocaleLowerCase())) {
        return { changed: false, entries }
      }
      entries.push(safe)
      await this.writeMemory(target, entries)
      return { changed: true, entries }
    })
  }

  async replaceMemory(
    target: MemoryTarget,
    oldText: string,
    content: string,
  ): Promise<{ changed: true; entries: string[] }> {
    const needle = normalizeOneLine(oldText)
    const safe = normalizeOneLine(assertSafePersistentText(content, "Memory entry"))
    if (!needle) throw new Error("old_text is required")
    return withStorageLock(this.dataRoot, async () => {
      const entries = await this.readMemory(target)
      const matches = entries.flatMap((entry, index) =>
        entry.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) ? [index] : [],
      )
      if (matches.length !== 1) {
        throw new Error(`old_text must match exactly one entry; found ${matches.length}`)
      }
      entries[matches[0]] = safe
      await this.writeMemory(target, entries)
      return { changed: true, entries }
    })
  }

  async removeMemory(
    target: MemoryTarget,
    oldText: string,
  ): Promise<{ changed: true; removed: string; entries: string[] }> {
    const needle = normalizeOneLine(oldText)
    if (!needle) throw new Error("old_text is required")
    return withStorageLock(this.dataRoot, async () => {
      const entries = await this.readMemory(target)
      const matches = entries.flatMap((entry, index) =>
        entry.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) ? [index] : [],
      )
      if (matches.length !== 1) {
        throw new Error(`old_text must match exactly one entry; found ${matches.length}`)
      }
      const [removed] = entries.splice(matches[0], 1)
      await this.writeMemory(target, entries)
      return { changed: true, removed, entries }
    })
  }

  private async writeMemory(target: MemoryTarget, entries: string[]): Promise<void> {
    const rendered = renderMemory(target, entries)
    const limit =
      target === "memory"
        ? this.config.memoryCharLimit
        : target === "user"
          ? this.config.userCharLimit
          : this.config.projectMemoryCharLimit
    if (rendered.length > limit) {
      throw new Error(
        `${target} would use ${rendered.length}/${limit} characters; consolidate old entries first`,
      )
    }
    await atomicWriteText(this.memoryFile(target), rendered)
  }

  private skillPath(name: string): string {
    return join(this.skillsRoot, assertSkillName(name), "SKILL.md")
  }

  private skillDirectory(name: string): string {
    return join(this.skillsRoot, assertSkillName(name))
  }

  private provenancePath(name: string): string {
    return join(this.provenanceRoot, `${assertSkillName(name)}.json`)
  }

  async readProvenance(name: string): Promise<SkillProvenance | undefined> {
    const safeName = assertSkillName(name)
    const value = await readJSON<unknown>(this.provenancePath(safeName), undefined)
    return validProvenance(value, safeName) ? value : undefined
  }

  private async trustedProvenance(name: string, skillContent: string): Promise<SkillProvenance | undefined> {
    const provenance = await this.readProvenance(name)
    return provenance?.contentHash === contentHash(skillContent) ? provenance : undefined
  }

  async listSkills(): Promise<SkillSummary[]> {
    await mkdir(this.skillsRoot, { recursive: true })
    const directories = await readdir(this.skillsRoot, { withFileTypes: true })
    const summaries: SkillSummary[] = []
    for (const directory of directories) {
      if (!directory.isDirectory() || !NAME_PATTERN.test(directory.name)) continue
      const path = this.skillPath(directory.name)
      try {
        const skillContent = await readFile(path, "utf8")
        const header = parseSkillHeader(skillContent)
        if (!header || header.name !== directory.name) continue
        const provenance = await this.trustedProvenance(directory.name, skillContent)
        summaries.push({
          name: header.name,
          description: header.description,
          path,
          owner: provenance?.owner ?? "user",
          autoManaged: provenance?.autoManaged ?? false,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name))
  }

  async viewSkill(name: string): Promise<{ content: string; provenance?: SkillProvenance }> {
    const safeName = assertSkillName(name)
    return withStorageLock(this.dataRoot, async () => {
      const content = await readFile(this.skillPath(safeName), "utf8")
      const provenance = await this.trustedProvenance(safeName, content)
      if (!provenance) return { content }
      const updated: SkillProvenance = { ...provenance, lastUsedAt: nowISO() }
      await atomicWriteText(this.provenancePath(safeName), `${JSON.stringify(updated, null, 2)}\n`)
      return { content, provenance: updated }
    })
  }

  async createSkill(input: {
    name: string
    description: string
    content: string
    owner: SkillOwner
    sourceSessionID?: string
  }): Promise<SkillSummary> {
    const name = assertSkillName(input.name)
    const description = normalizeDescription(input.description)
    const rendered = renderSkill(name, description, input.content)
    const path = this.skillPath(name)
    return withStorageLock(this.dataRoot, async () => {
      await assertPlainDirectory(this.skillsRoot, "skillsRoot")
      const skillDirectory = this.skillDirectory(name)
      try {
        await mkdir(skillDirectory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Skill ${name} already exists; use update after reading it`)
        }
        throw error
      }
      try {
        await createTextExclusive(path, rendered)
      } catch (error) {
        await rmdir(skillDirectory).catch(() => undefined)
        throw error
      }
      const timestamp = nowISO()
      const provenance: SkillProvenance = {
        schemaVersion: 1,
        name,
        owner: input.owner,
        autoManaged: input.owner === "agent",
        contentHash: contentHash(rendered),
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceSessionID: input.sourceSessionID,
      }
      await atomicWriteText(this.provenancePath(name), `${JSON.stringify(provenance, null, 2)}\n`)
      return { name, description, path, owner: provenance.owner, autoManaged: provenance.autoManaged }
    })
  }

  async updateSkill(input: {
    name: string
    description: string
    content: string
    origin: SkillOwner
    sourceSessionID?: string
  }): Promise<SkillSummary> {
    const name = assertSkillName(input.name)
    const description = normalizeDescription(input.description)
    const rendered = renderSkill(name, description, input.content)
    const path = this.skillPath(name)
    return withStorageLock(this.dataRoot, async () => {
      await assertPlainDirectory(this.skillsRoot, "skillsRoot")
      await assertPlainDirectory(this.skillDirectory(name), `Skill directory ${name}`)
      const current = await readFile(path, "utf8")
      const existing = await this.readProvenance(name)
      const trusted = existing?.contentHash === contentHash(current) ? existing : undefined
      if (
        input.origin === "agent" &&
        (!trusted || trusted.owner !== "agent" || trusted.autoManaged !== true)
      ) {
        throw new Error(`Automatic review cannot modify user-owned Skill ${name}`)
      }
      const beforeWrite = await readFile(path, "utf8")
      if (contentHash(beforeWrite) !== contentHash(current)) {
        throw new Error(`Skill ${name} changed while it was being updated; read it and retry`)
      }
      await atomicWriteText(path, rendered)
      const timestamp = nowISO()
      const provenance: SkillProvenance =
        input.origin === "user"
          ? {
              schemaVersion: 1,
              name,
              owner: "user",
              autoManaged: false,
              contentHash: contentHash(rendered),
              createdAt: trusted?.createdAt ?? timestamp,
              updatedAt: timestamp,
            }
          : { ...trusted!, contentHash: contentHash(rendered), updatedAt: timestamp }
      provenance.updatedAt = timestamp
      provenance.sourceSessionID = input.sourceSessionID ?? provenance.sourceSessionID
      await atomicWriteText(this.provenancePath(name), `${JSON.stringify(provenance, null, 2)}\n`)
      return { name, description, path, owner: provenance.owner, autoManaged: provenance.autoManaged }
    })
  }

  async deleteSkill(input: {
    name: string
    origin: SkillOwner
    sourceSessionID?: string
    absorbedInto?: string
  }): Promise<{ name: string; archived: true; archivePath: string; absorbedInto?: string }> {
    const name = assertSkillName(input.name)
    const absorbedInto = input.absorbedInto?.trim()
    if (absorbedInto) {
      const target = assertSkillName(absorbedInto)
      if (target === name) throw new Error("absorbed_into cannot equal the deleted Skill")
      await readFile(this.skillPath(target), "utf8")
    }
    return withStorageLock(this.dataRoot, async () => {
      await assertPlainDirectory(this.skillsRoot, "skillsRoot")
      const skillDirectory = this.skillDirectory(name)
      await assertPlainDirectory(skillDirectory, `Skill directory ${name}`)
      const current = await readFile(this.skillPath(name), "utf8")
      const provenance = await this.trustedProvenance(name, current)
      if (
        input.origin === "agent" &&
        (!provenance || provenance.owner !== "agent" || provenance.autoManaged !== true)
      ) {
        throw new Error(`Automatic review cannot delete user-owned Skill ${name}`)
      }
      const archiveName = `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`
      const archivePath = join(this.skillArchiveRoot, archiveName)
      const metadataPath = join(skillDirectory, ".continuous-learning-archive.json")
      await atomicWriteText(
        metadataPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            name,
            archivedAt: nowISO(),
            owner: provenance?.owner ?? "user",
            sourceSessionID: input.sourceSessionID,
            absorbedInto,
            provenance,
          },
          null,
          2,
        )}\n`,
      )
      try {
        await rename(skillDirectory, archivePath)
      } catch (error) {
        await rm(metadataPath, { force: true }).catch(() => undefined)
        throw error
      }
      await rm(this.provenancePath(name), { force: true })
      return { name, archived: true, archivePath, absorbedInto }
    })
  }

  async getReviewState(): Promise<ReviewState> {
    const value = await readJSON<unknown>(this.reviewStatePath, undefined)
    if (!value || typeof value !== "object") return { schemaVersion: 1, sessions: {} }
    const item = value as Record<string, unknown>
    if (item.schemaVersion !== 1 || !item.sessions || typeof item.sessions !== "object") {
      return { schemaVersion: 1, sessions: {} }
    }
    return value as ReviewState
  }

  async getCheckpoint(sessionID: string): Promise<ReviewCheckpoint> {
    return (await this.getReviewState()).sessions[sessionID] ?? { userTurns: 0, toolCalls: 0 }
  }

  async updateCheckpoint(sessionID: string, value: ReviewCheckpoint): Promise<void> {
    await withStorageLock(this.dataRoot, async () => {
      const state = await this.getReviewState()
      state.sessions[sessionID] = value
      await atomicWriteText(this.reviewStatePath, `${JSON.stringify(state, null, 2)}\n`)
    })
  }

  async deleteCheckpoint(sessionID: string): Promise<void> {
    await withStorageLock(this.dataRoot, async () => {
      const state = await this.getReviewState()
      if (!(sessionID in state.sessions)) return
      delete state.sessions[sessionID]
      await atomicWriteText(this.reviewStatePath, `${JSON.stringify(state, null, 2)}\n`)
    })
  }

  async buildSystemSnapshot(): Promise<string> {
    const [memory, user, project, skills] = await Promise.all([
      this.readMemory("memory"),
      this.readMemory("user"),
      this.projectRoot ? this.readMemory("project") : Promise.resolve([]),
      this.listSkills(),
    ])
    const renderEntries = (entries: string[]) =>
      entries.length ? entries.map((entry) => `- ${JSON.stringify(entry)}`).join("\n") : "- (empty)"
    const skillIndex = skills.length
      ? skills.map((skill) => `- ${skill.name}: ${JSON.stringify(skill.description)}`).join("\n")
      : "- (none)"
    return [
      "<persistent-learning-snapshot>",
      "This snapshot is frozen for the current session. Do not assume a write changes it immediately.",
      "Use global memory only for facts that apply across projects, user for durable preferences, and project for facts specific to the active project.",
      "Save reusable procedures with learning_skill. Do not copy project-local facts into global memory.",
      "Never save secrets, transient task state, or unverified guesses. Load a relevant Skill with learning_skill view before following it.",
      "",
      "Durable memory:",
      renderEntries(memory),
      "",
      "User profile:",
      renderEntries(user),
      "",
      `Active project: ${this.projectRoot ? JSON.stringify(this.projectRoot) : "(none)"}`,
      "Project memory:",
      renderEntries(project),
      "",
      "Available learned Skills (index only):",
      skillIndex,
      "</persistent-learning-snapshot>",
    ].join("\n")
  }
}

export function countTranscript(items: TranscriptItem[]): {
  userTurns: number
  toolCalls: number
  lastMessageID?: string
} {
  return {
    userTurns: items.filter((item) => item.role === "user").length,
    toolCalls: items.reduce(
      (count, item) =>
        count + item.toolCalls.filter((toolCall) => ["completed", "error"].includes(toolCall.status)).length,
      0,
    ),
    lastMessageID: items.at(-1)?.id,
  }
}

export function isReviewDue(
  counts: ReturnType<typeof countTranscript>,
  checkpoint: ReviewCheckpoint,
  config: LearningConfig,
  now = Date.now(),
): { due: boolean; memoryDue: boolean; skillDue: boolean } {
  const memoryDue = counts.userTurns - checkpoint.userTurns >= config.memoryEveryTurns
  const skillDue = counts.toolCalls - checkpoint.toolCalls >= config.skillEveryToolCalls
  if (!memoryDue && !skillDue) return { due: false, memoryDue, skillDue }
  if (checkpoint.lastAttemptAt && checkpoint.lastError) {
    const retryAt = Date.parse(checkpoint.lastAttemptAt) + config.retryCooldownMinutes * 60_000
    if (Number.isFinite(retryAt) && retryAt > now) return { due: false, memoryDue, skillDue }
  }
  return { due: true, memoryDue, skillDue }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`
}

export function renderTranscript(items: TranscriptItem[], maxCharacters: number): string {
  const chunks = items.map((item) => {
    const lines = [`[${item.role.toUpperCase()} ${item.id}]`, item.text || "(no text)"]
    for (const call of item.toolCalls) {
      const input = call.input === undefined ? "" : ` input=${truncate(JSON.stringify(call.input), 1_500)}`
      const output = call.output ? `\n${truncate(call.output, 2_500)}` : ""
      lines.push(`[TOOL ${call.name} ${call.status}]${input}${output}`)
    }
    return lines.join("\n")
  })
  const selected: string[] = []
  let used = 0
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = truncate(chunks[index], maxCharacters)
    if (selected.length && used + chunk.length + 2 > maxCharacters) break
    selected.unshift(chunk)
    used += chunk.length + 2
  }
  return selected.join("\n\n")
}
