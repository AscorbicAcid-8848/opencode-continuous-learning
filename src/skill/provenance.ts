import type { SkillOwner } from "../config/schema.ts";

export interface SkillProvenance {
  schemaVersion: 1;
  name: string;
  owner: SkillOwner;
  autoManaged: boolean;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  sourceSessionID?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  owner: SkillOwner;
  autoManaged: boolean;
}

export function validProvenance(
  value: unknown,
  name: string,
): value is SkillProvenance {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.schemaVersion === 1 &&
    item.name === name &&
    (item.owner === "user" || item.owner === "agent") &&
    typeof item.autoManaged === "boolean" &&
    typeof item.contentHash === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(item.contentHash) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}
