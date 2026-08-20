import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  type LearningConfig,
  type MemoryTarget,
  type SkillOwner,
} from "./config.ts";
import { atomicWriteText } from "./shared.ts";
import { MemoryStore } from "./memory.ts";
import { SkillStore } from "./skill.ts";

export type PendingPayload =
  | {
      kind: "memory";
      action: "add" | "replace" | "remove";
      target: MemoryTarget;
      content?: string;
      oldText?: string;
    }
  | {
      kind: "skill";
      action: "create" | "update" | "delete";
      name: string;
      description?: string;
      content?: string;
      owner: SkillOwner;
      sourceSessionID?: string;
      absorbedInto?: string;
    };

export interface PendingRecord {
  schemaVersion: 1;
  id: string;
  summary: string;
  origin: "background_review";
  projectRoot: string;
  createdAt: string;
  payload: PendingPayload;
}

export function validPending(value: unknown): value is PendingRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.schemaVersion === 1 &&
    typeof item.id === "string" &&
    typeof item.summary === "string" &&
    item.origin === "background_review" &&
    typeof item.projectRoot === "string" &&
    typeof item.createdAt === "string" &&
    Boolean(item.payload && typeof item.payload === "object")
  );
}

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

export async function applyPendingRecord(
  record: PendingRecord,
  input: { dataRoot: string; skillsRoot: string; config: LearningConfig },
): Promise<unknown> {
  if (!input.config.enabled) throw new Error("Continuous learning is disabled");
  const memoryStore = new MemoryStore(
    input.dataRoot,
    input.config,
    record.projectRoot,
  );
  await memoryStore.ensureLayout();
  const skillStore = new SkillStore(
    input.dataRoot,
    input.skillsRoot,
    input.config,
  );
  await skillStore.ensureLayout();
  const payload = record.payload;
  if (payload.kind === "memory") {
    if (payload.action === "add")
      return memoryStore.addMemory(payload.target, payload.content ?? "");
    if (payload.action === "replace") {
      return memoryStore.replaceMemory(
        payload.target,
        payload.oldText ?? "",
        payload.content ?? "",
      );
    }
    return memoryStore.removeMemory(payload.target, payload.oldText ?? "");
  }
  if (payload.action === "create") {
    return skillStore.createSkill({
      name: payload.name,
      description: payload.description ?? "",
      content: payload.content ?? "",
      owner: payload.owner,
      sourceSessionID: payload.sourceSessionID,
    });
  }
  if (payload.action === "update") {
    return skillStore.updateSkill({
      name: payload.name,
      description: payload.description ?? "",
      content: payload.content ?? "",
      origin: payload.owner,
      sourceSessionID: payload.sourceSessionID,
    });
  }
  return skillStore.deleteSkill({
    name: payload.name,
    origin: payload.owner,
    sourceSessionID: payload.sourceSessionID,
    absorbedInto: payload.absorbedInto,
  });
}
