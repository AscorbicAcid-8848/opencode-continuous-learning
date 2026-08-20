import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { type LearningConfig, type SkillOwner } from "./config.ts";
import {
  atomicWriteText,
  createTextExclusive,
  readJSON,
  withStorageLock,
  nowISO,
} from "./shared.ts";
import { assertSafePersistentText, normalizeOneLine } from "./safety.ts";

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

async function assertPlainDirectory(
  path: string,
  label: string,
): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(
      `${label} must be a real directory, not a symlink or junction: ${path}`,
    );
  }
}

export interface SkillPaths {
  readonly skillsRoot: string;
  readonly provenanceRoot: string;
  readonly skillArchiveRoot: string;
}

export class SkillStore implements SkillPaths {
  readonly dataRoot: string;
  readonly skillsRoot: string;
  readonly provenanceRoot: string;
  readonly skillArchiveRoot: string;
  readonly config: LearningConfig;

  constructor(dataRoot: string, skillsRoot: string, config: LearningConfig) {
    if (!isAbsolute(dataRoot) || !isAbsolute(skillsRoot)) {
      throw new Error(
        "Persistent learning dataRoot and skillsRoot must be absolute paths",
      );
    }
    this.dataRoot = resolve(dataRoot);
    this.skillsRoot = resolve(skillsRoot);
    this.config = config;
    this.provenanceRoot = join(this.dataRoot, "skill-provenance");
    this.skillArchiveRoot = join(
      this.skillsRoot,
      ".continuous-learning-archive",
    );
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.skillsRoot, { recursive: true }),
      mkdir(this.provenanceRoot, { recursive: true }),
      mkdir(this.skillArchiveRoot, { recursive: true }),
    ]);
    await Promise.all([
      assertPlainDirectory(this.skillsRoot, "skillsRoot"),
      assertPlainDirectory(this.provenanceRoot, "provenanceRoot"),
      assertPlainDirectory(this.skillArchiveRoot, "skillArchiveRoot"),
    ]);
  }

  private skillPath(name: string): string {
    return join(this.skillsRoot, assertSkillName(name), "SKILL.md");
  }

  private skillDirectory(name: string): string {
    return join(this.skillsRoot, assertSkillName(name));
  }

  private provenancePath(name: string): string {
    return join(this.provenanceRoot, `${assertSkillName(name)}.json`);
  }

  async readProvenance(name: string): Promise<SkillProvenance | undefined> {
    const safeName = assertSkillName(name);
    const value = await readJSON<unknown>(
      this.provenancePath(safeName),
      undefined,
    );
    return validProvenance(value, safeName) ? value : undefined;
  }

  private async trustedProvenance(
    name: string,
    skillContent: string,
  ): Promise<SkillProvenance | undefined> {
    const provenance = await this.readProvenance(name);
    return provenance?.contentHash === contentHash(skillContent)
      ? provenance
      : undefined;
  }

  async listSkills(): Promise<SkillSummary[]> {
    await mkdir(this.skillsRoot, { recursive: true });
    const directories = await readdir(this.skillsRoot, { withFileTypes: true });
    const summaries: SkillSummary[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory() || !NAME_PATTERN.test(directory.name))
        continue;
      const path = this.skillPath(directory.name);
      try {
        const skillContent = await readFile(path, "utf8");
        const header = parseSkillHeader(skillContent);
        if (!header || header.name !== directory.name) continue;
        const provenance = await this.trustedProvenance(
          directory.name,
          skillContent,
        );
        summaries.push({
          name: header.name,
          description: header.description,
          path,
          owner: provenance?.owner ?? "user",
          autoManaged: provenance?.autoManaged ?? false,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return summaries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async viewSkill(
    name: string,
  ): Promise<{ content: string; provenance?: SkillProvenance }> {
    const safeName = assertSkillName(name);
    return withStorageLock(this.dataRoot, async () => {
      const content = await readFile(this.skillPath(safeName), "utf8");
      const provenance = await this.trustedProvenance(safeName, content);
      if (!provenance) return { content };
      const updated: SkillProvenance = { ...provenance, lastUsedAt: nowISO() };
      await atomicWriteText(
        this.provenancePath(safeName),
        `${JSON.stringify(updated, null, 2)}\n`,
      );
      return { content, provenance: updated };
    });
  }

  async createSkill(input: {
    name: string;
    description: string;
    content: string;
    owner: SkillOwner;
    sourceSessionID?: string;
  }): Promise<SkillSummary> {
    const name = assertSkillName(input.name);
    const description = normalizeDescription(input.description);
    const rendered = renderSkill(name, description, input.content);
    const path = this.skillPath(name);
    return withStorageLock(this.dataRoot, async () => {
      await assertPlainDirectory(this.skillsRoot, "skillsRoot");
      const skillDirectory = this.skillDirectory(name);
      try {
        await mkdir(skillDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            `Skill ${name} already exists; use update after reading it`,
          );
        }
        throw error;
      }
      try {
        await createTextExclusive(path, rendered);
      } catch (error) {
        await rmdir(skillDirectory).catch(() => undefined);
        throw error;
      }
      const timestamp = nowISO();
      const provenance: SkillProvenance = {
        schemaVersion: 1,
        name,
        owner: input.owner,
        autoManaged: input.owner === "agent",
        contentHash: contentHash(rendered),
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceSessionID: input.sourceSessionID,
      };
      await atomicWriteText(
        this.provenancePath(name),
        `${JSON.stringify(provenance, null, 2)}\n`,
      );
      return {
        name,
        description,
        path,
        owner: provenance.owner,
        autoManaged: provenance.autoManaged,
      };
    });
  }

  async updateSkill(input: {
    name: string;
    description: string;
    content: string;
    origin: SkillOwner;
    sourceSessionID?: string;
  }): Promise<SkillSummary> {
    const name = assertSkillName(input.name);
    const description = normalizeDescription(input.description);
    const rendered = renderSkill(name, description, input.content);
    const path = this.skillPath(name);
    return withStorageLock(this.dataRoot, async () => {
      await assertPlainDirectory(this.skillsRoot, "skillsRoot");
      await assertPlainDirectory(
        this.skillDirectory(name),
        `Skill directory ${name}`,
      );
      const current = await readFile(path, "utf8");
      const existing = await this.readProvenance(name);
      const trusted =
        existing?.contentHash === contentHash(current) ? existing : undefined;
      if (
        input.origin === "agent" &&
        (!trusted || trusted.owner !== "agent" || trusted.autoManaged !== true)
      ) {
        throw new Error(
          `Automatic review cannot modify user-owned Skill ${name}`,
        );
      }
      const beforeWrite = await readFile(path, "utf8");
      if (contentHash(beforeWrite) !== contentHash(current)) {
        throw new Error(
          `Skill ${name} changed while it was being updated; read it and retry`,
        );
      }
      await atomicWriteText(path, rendered);
      const timestamp = nowISO();
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
          : {
              ...trusted!,
              contentHash: contentHash(rendered),
              updatedAt: timestamp,
            };
      provenance.updatedAt = timestamp;
      provenance.sourceSessionID =
        input.sourceSessionID ?? provenance.sourceSessionID;
      await atomicWriteText(
        this.provenancePath(name),
        `${JSON.stringify(provenance, null, 2)}\n`,
      );
      return {
        name,
        description,
        path,
        owner: provenance.owner,
        autoManaged: provenance.autoManaged,
      };
    });
  }

  async deleteSkill(input: {
    name: string;
    origin: SkillOwner;
    sourceSessionID?: string;
    absorbedInto?: string;
  }): Promise<{
    name: string;
    archived: true;
    archivePath: string;
    absorbedInto?: string;
  }> {
    const name = assertSkillName(input.name);
    const absorbedInto = input.absorbedInto?.trim();
    if (absorbedInto) {
      const target = assertSkillName(absorbedInto);
      if (target === name)
        throw new Error("absorbed_into cannot equal the deleted Skill");
      await readFile(this.skillPath(target), "utf8");
    }
    return withStorageLock(this.dataRoot, async () => {
      await assertPlainDirectory(this.skillsRoot, "skillsRoot");
      const skillDirectory = this.skillDirectory(name);
      await assertPlainDirectory(skillDirectory, `Skill directory ${name}`);
      const current = await readFile(this.skillPath(name), "utf8");
      const provenance = await this.trustedProvenance(name, current);
      if (
        input.origin === "agent" &&
        (!provenance ||
          provenance.owner !== "agent" ||
          provenance.autoManaged !== true)
      ) {
        throw new Error(
          `Automatic review cannot delete user-owned Skill ${name}`,
        );
      }
      const archiveName = `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const archivePath = join(this.skillArchiveRoot, archiveName);
      const metadataPath = join(
        skillDirectory,
        ".continuous-learning-archive.json",
      );
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
      );
      try {
        await rename(skillDirectory, archivePath);
      } catch (error) {
        await rm(metadataPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await rm(this.provenancePath(name), { force: true });
      return { name, archived: true, archivePath, absorbedInto };
    });
  }
}

export { NAME_PATTERN };
