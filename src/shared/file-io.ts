import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { sleep } from "./utils.ts";

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
