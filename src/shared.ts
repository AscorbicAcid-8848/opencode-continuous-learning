import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { homedir, hostname } from "node:os";

export type UnknownRecord = Record<string, unknown>;

// ── general utilities ─────────────────────────────────────────────────

export function resolveOption(
  options: UnknownRecord | undefined,
  optionName: string,
  fallback: string,
): string {
  const value = options?.[optionName];
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required for this action`);
  return value.trim();
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function defaultDataRoot(): string {
  return join(homedir(), ".local", "share", "opencode", "continuous-learning");
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ── atomic file I/O ───────────────────────────────────────────────────

const MAX_RENAME_RETRIES = 5;
const RENAME_RETRY_BASE_DELAY_MS = 25;
const RETRYABLE_ERRNO_CODES = ["EACCES", "EBUSY", "EPERM"] as const;

export async function atomicWriteText(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${randomUUID()}.${path.split(/[\\/]/).at(-1)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          attempt >= MAX_RENAME_RETRIES ||
          !RETRYABLE_ERRNO_CODES.includes(code as never)
        )
          throw error;
        await sleep(RENAME_RETRY_BASE_DELAY_MS * (attempt + 1));
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function createTextExclusive(
  path: string,
  content: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx");
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

// ── cross-process file lock ──────────────────────────────────────────

interface StorageLockInfo {
  owner: string;
  pid: number;
  host: string;
  createdAt: number;
}

// A lease long enough to cover any single serialized write, but short enough that
// a lock left behind by a crashed one-shot `opencode run` is reclaimed promptly.
const STORAGE_LOCK_LEASE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 8_000;
const LOCK_POLL_INTERVAL_MS = 40;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; treat it as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockInfo(contents: string): StorageLockInfo | undefined {
  const trimmed = contents.trim();
  if (trimmed.startsWith("{")) {
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
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
        };
      }
    } catch {
      // Fall through to the legacy text format below.
    }
  }
  // Legacy format: `<pid>:<uuid>\n<ISO timestamp>\n`.
  const lines = contents.replace(/\r\n/gu, "\n").split("\n");
  const owner = lines[0]?.trim();
  if (!owner) return undefined;
  const pid = Number(/^(\d+):/u.exec(owner)?.[1] ?? Number.NaN);
  const createdAt = Date.parse(lines[1] ?? "");
  return {
    owner,
    pid,
    host: "",
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

function isStaleLock(
  info: StorageLockInfo,
  now: number,
  localHost: string,
): boolean {
  if (info.host === localHost) return !isProcessAlive(info.pid);
  if (info.host)
    return info.createdAt > 0 && now - info.createdAt >= STORAGE_LOCK_LEASE_MS;
  // Legacy locks carried no host. Trust the local PID when one is recorded;
  // otherwise fall back to the creation-time lease.
  if (Number.isInteger(info.pid) && info.pid > 0)
    return !isProcessAlive(info.pid);
  return info.createdAt > 0
    ? now - info.createdAt >= STORAGE_LOCK_LEASE_MS
    : true;
}

async function readLockInfo(
  lockPath: string,
): Promise<StorageLockInfo | undefined> {
  try {
    return parseLockInfo(await readFile(lockPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function reclaimStaleLock(
  lockPath: string,
  observed: StorageLockInfo,
): Promise<boolean> {
  const current = await readLockInfo(lockPath);
  if (!current) return true;
  // Re-read before deleting: only remove the exact lock we observed, never a lock
  // another process created in the meantime.
  if (
    current.owner !== observed.owner ||
    current.createdAt !== observed.createdAt
  )
    return false;
  await rm(lockPath, { force: true });
  return true;
}

export async function withStorageLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".write.lock");
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  const localHost = hostname();
  const owner = `${process.pid}:${randomUUID()}`;
  const lockInfo: StorageLockInfo = {
    owner,
    pid: process.pid,
    host: localHost,
    createdAt: Date.now(),
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(lockInfo)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await readLockInfo(lockPath);
      if (observed && isStaleLock(observed, Date.now(), localHost)) {
        if (await reclaimStaleLock(lockPath, observed)) continue;
      }
      if (Date.now() >= deadline)
        throw new Error("Persistent learning storage is busy");
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    try {
      const contents = await readFile(lockPath, "utf8");
      if (parseLockInfo(contents)?.owner === owner)
        await rm(lockPath, { force: true });
    } catch {
      // A missing or externally replaced lock must not be removed blindly.
    }
  }
}

// re-export for convenience (used by config/paths.ts)
export { createHash };
