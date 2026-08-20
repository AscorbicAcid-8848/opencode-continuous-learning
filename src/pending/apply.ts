import { type LearningConfig } from "../config/schema.ts";
import { MemoryStore } from "../memory/store.ts";
import { SkillStore } from "../skill/store.ts";
import { type PendingRecord } from "./types.ts";

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
