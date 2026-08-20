import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteText } from "../shared/file-io.ts";
import { type PendingRecord, validPending } from "./types.ts";

export class PendingWriteStore {
  readonly root: string;
  readonly historyRoot: string;

  constructor(dataRoot: string) {
    this.root = join(dataRoot, "pending");
    this.historyRoot = join(this.root, "history");
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.historyRoot, { recursive: true }),
    ]);
  }

  async stage(
    input: Omit<PendingRecord, "schemaVersion" | "id" | "createdAt">,
  ): Promise<PendingRecord> {
    await this.ensureLayout();
    const record: PendingRecord = {
      schemaVersion: 1,
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      createdAt: new Date().toISOString(),
      ...input,
    };
    await atomicWriteText(
      this.recordPath(record.id),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }

  async list(): Promise<PendingRecord[]> {
    await this.ensureLayout();
    const names = await readdir(this.root);
    const records = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{12}\.json$/u.test(name))
        .map(async (name) => {
          try {
            const value = JSON.parse(
              await readFile(join(this.root, name), "utf8"),
            ) as unknown;
            return validPending(value) ? value : undefined;
          } catch {
            return undefined;
          }
        }),
    );
    return records
      .filter((record): record is PendingRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<PendingRecord | undefined> {
    if (!/^[a-f0-9]{12}$/u.test(id))
      throw new Error("Invalid pending write id");
    try {
      const value = JSON.parse(
        await readFile(this.recordPath(id), "utf8"),
      ) as unknown;
      return validPending(value) ? value : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async approve(
    id: string,
    apply: (record: PendingRecord) => Promise<unknown>,
  ): Promise<unknown> {
    const record = await this.get(id);
    if (!record) throw new Error(`Pending write not found: ${id}`);
    const processing = join(this.root, `${id}.processing`);
    await rename(this.recordPath(id), processing);
    try {
      const result = await apply(record);
      await atomicWriteText(
        join(this.historyRoot, `${id}.approved.json`),
        `${JSON.stringify({ ...record, resolvedAt: new Date().toISOString(), status: "approved" }, null, 2)}\n`,
      );
      await rm(processing, { force: true });
      return result;
    } catch (error) {
      await rename(processing, this.recordPath(id)).catch(() => undefined);
      throw error;
    }
  }

  async reject(id: string): Promise<PendingRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`Pending write not found: ${id}`);
    await atomicWriteText(
      join(this.historyRoot, `${id}.rejected.json`),
      `${JSON.stringify({ ...record, resolvedAt: new Date().toISOString(), status: "rejected" }, null, 2)}\n`,
    );
    await rm(this.recordPath(id), { force: true });
    return record;
  }

  private recordPath(id: string): string {
    return join(this.root, `${id}.json`);
  }
}
