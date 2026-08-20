import { createHash } from "node:crypto";

import {
  assertSafePersistentText,
  normalizeOneLine,
} from "../safety/text-guard.ts";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function assertSkillName(name: string): string {
  const normalized = name.trim();
  if (
    normalized.length > 64 ||
    !NAME_PATTERN.test(normalized) ||
    WINDOWS_RESERVED_NAME.test(normalized)
  ) {
    throw new Error(
      "Skill name must be 1-64 lowercase letters, digits, and single hyphens",
    );
  }
  return normalized;
}

export function normalizeDescription(description: string): string {
  const normalized = normalizeOneLine(
    assertSafePersistentText(description, "Skill description"),
  );
  if (normalized.length > 500)
    throw new Error("Skill description must be at most 500 characters");
  return normalized;
}

export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/gu, "\n").trim();
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  return end === -1 ? normalized : normalized.slice(end + 5).trim();
}

export function renderSkill(
  name: string,
  description: string,
  content: string,
): string {
  const body = stripFrontmatter(
    assertSafePersistentText(content, "Skill content"),
  );
  if (body.length > 100_000)
    throw new Error("Skill content must be at most 100,000 characters");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

export function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function decodeYAMLScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.replace(/^"|"$/gu, "");
    }
  }
  return trimmed.replace(/^['"]|['"]$/gu, "");
}

export function parseSkillHeader(
  raw: string,
): { name: string; description: string } | undefined {
  if (!raw.startsWith("---")) return undefined;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const header = raw.slice(3, end);
  const name = /^name:\s*(.+)$/imu.exec(header)?.[1];
  const description = /^description:\s*(.+)$/imu.exec(header)?.[1];
  if (!name || !description) return undefined;
  return {
    name: decodeYAMLScalar(name),
    description: decodeYAMLScalar(description),
  };
}

export { NAME_PATTERN };
