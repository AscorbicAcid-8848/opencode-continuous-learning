import { type MemoryTarget, type SkillOwner } from "../config/schema.ts";

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
