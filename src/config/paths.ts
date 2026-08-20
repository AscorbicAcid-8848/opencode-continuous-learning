import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDataRoot(): string {
  return join(homedir(), ".local", "share", "opencode", "continuous-learning");
}

export function projectStorageName(projectRoot: string): string {
  const root = resolve(projectRoot);
  const label =
    basename(root)
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 40)
      .toLocaleLowerCase() || "project";
  const hash = createHash("sha256")
    .update(root, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${label}-${hash}`;
}
