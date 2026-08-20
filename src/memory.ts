import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type LearningConfig,
  type MemoryTarget,
  projectStorageName,
} from "./config.ts";
import { atomicWriteText, withStorageLock } from "./shared.ts";
import {
  assertSafePersistentText,
  MEMORY_HEADERS,
  normalizeOneLine,
} from "./safety.ts";

function pathsOverlap(left: string, right: string): boolean {
  const relation = relative(left, right);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
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

export function renderMemory(target: MemoryTarget, entries: string[]): string {
  const body = entries
    .map((entry) => `- ${normalizeOneLine(entry)}`)
    .join("\n");
  return `${MEMORY_HEADERS[target]}\n\n<!-- Managed by opencode-continuous-learning. One durable fact per line. -->\n${body}${body ? "\n" : ""}`;
}

export function parseMemory(raw: string, target: MemoryTarget): string[] {
  const lines = raw.replace(/\r\n/gu, "\n").split("\n");
  if (lines[0] !== MEMORY_HEADERS[target]) {
    throw new Error(
      `${target} file is not in the managed format; refusing to overwrite it`,
    );
  }
  const entries: string[] = [];
  for (const line of lines.slice(1)) {
    if (
      !line ||
      line ===
        "<!-- Managed by opencode-continuous-learning. One durable fact per line. -->"
    ) {
      continue;
    }
    if (!line.startsWith("- ") || !line.slice(2).trim()) {
      throw new Error(
        `${target} file contains unmanaged content; refusing to overwrite it`,
      );
    }
    entries.push(line.slice(2).trim());
  }
  return entries;
}

export interface MemoryPaths {
  readonly dataRoot: string;
  readonly memoryPath: string;
  readonly userPath: string;
  readonly projectsRoot: string;
  readonly projectMemoryPath?: string;
}

export class MemoryStore implements MemoryPaths {
  readonly dataRoot: string;
  readonly memoryPath: string;
  readonly userPath: string;
  readonly projectsRoot: string;
  readonly projectMemoryPath?: string;
  readonly config: LearningConfig;
  readonly projectRoot?: string;

  constructor(dataRoot: string, config: LearningConfig, projectRoot?: string) {
    if (!isAbsolute(dataRoot)) {
      throw new Error("Persistent learning dataRoot must be an absolute path");
    }
    this.dataRoot = resolve(dataRoot);
    this.config = config;
    this.memoryPath = join(this.dataRoot, "MEMORY.md");
    this.userPath = join(this.dataRoot, "USER.md");
    this.projectRoot = projectRoot ? resolve(projectRoot) : undefined;
    this.projectsRoot = join(this.dataRoot, "projects");
    this.projectMemoryPath = this.projectRoot
      ? join(
          this.projectsRoot,
          projectStorageName(this.projectRoot),
          "MEMORY.md",
        )
      : undefined;
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(this.dataRoot, { recursive: true }),
      mkdir(this.projectsRoot, { recursive: true }),
      this.projectMemoryPath
        ? mkdir(dirname(this.projectMemoryPath), { recursive: true })
        : Promise.resolve(),
    ]);
    await Promise.all([
      assertPlainDirectory(this.dataRoot, "dataRoot"),
      assertPlainDirectory(this.projectsRoot, "projectsRoot"),
      this.projectMemoryPath
        ? assertPlainDirectory(
            dirname(this.projectMemoryPath),
            "project memory directory",
          )
        : Promise.resolve(),
    ]);
  }

  private memoryFile(target: MemoryTarget): string {
    if (target === "memory") return this.memoryPath;
    if (target === "user") return this.userPath;
    if (!this.projectMemoryPath)
      throw new Error("No project scope is active for project memory");
    return this.projectMemoryPath;
  }

  async readMemory(target: MemoryTarget): Promise<string[]> {
    try {
      return parseMemory(
        await readFile(this.memoryFile(target), "utf8"),
        target,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async addMemory(
    target: MemoryTarget,
    content: string,
  ): Promise<{ changed: boolean; entries: string[] }> {
    const safe = normalizeOneLine(
      assertSafePersistentText(content, "Memory entry"),
    );
    return withStorageLock(this.dataRoot, async () => {
      const entries = await this.readMemory(target);
      if (
        entries.some(
          (entry) => entry.toLocaleLowerCase() === safe.toLocaleLowerCase(),
        )
      ) {
        return { changed: false, entries };
      }
      entries.push(safe);
      await this.writeMemory(target, entries);
      return { changed: true, entries };
    });
  }

  async replaceMemory(
    target: MemoryTarget,
    oldText: string,
    content: string,
  ): Promise<{ changed: true; entries: string[] }> {
    const needle = normalizeOneLine(oldText);
    const safe = normalizeOneLine(
      assertSafePersistentText(content, "Memory entry"),
    );
    if (!needle) throw new Error("old_text is required");
    return withStorageLock(this.dataRoot, async () => {
      const entries = await this.readMemory(target);
      const matches = entries.flatMap((entry, index) =>
        entry.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
          ? [index]
          : [],
      );
      if (matches.length !== 1) {
        throw new Error(
          `old_text must match exactly one entry; found ${matches.length}`,
        );
      }
      entries[matches[0]] = safe;
      await this.writeMemory(target, entries);
      return { changed: true, entries };
    });
  }

  async removeMemory(
    target: MemoryTarget,
    oldText: string,
  ): Promise<{ changed: true; removed: string; entries: string[] }> {
    const needle = normalizeOneLine(oldText);
    if (!needle) throw new Error("old_text is required");
    return withStorageLock(this.dataRoot, async () => {
      const entries = await this.readMemory(target);
      const matches = entries.flatMap((entry, index) =>
        entry.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
          ? [index]
          : [],
      );
      if (matches.length !== 1) {
        throw new Error(
          `old_text must match exactly one entry; found ${matches.length}`,
        );
      }
      const [removed] = entries.splice(matches[0], 1);
      await this.writeMemory(target, entries);
      return { changed: true, removed, entries };
    });
  }

  private async writeMemory(
    target: MemoryTarget,
    entries: string[],
  ): Promise<void> {
    const rendered = renderMemory(target, entries);
    const limit =
      target === "memory"
        ? this.config.memoryCharLimit
        : target === "user"
          ? this.config.userCharLimit
          : this.config.projectMemoryCharLimit;
    if (rendered.length > limit) {
      throw new Error(
        `${target} would use ${rendered.length}/${limit} characters; consolidate old entries first`,
      );
    }
    await atomicWriteText(this.memoryFile(target), rendered);
  }
}
