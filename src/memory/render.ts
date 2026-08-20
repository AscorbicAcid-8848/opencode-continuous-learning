import type { MemoryTarget } from "../config/schema.ts";
import { MEMORY_HEADERS, normalizeOneLine } from "../safety/text-guard.ts";

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
