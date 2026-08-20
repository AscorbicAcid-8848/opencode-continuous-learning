import { join } from "node:path";
import { homedir } from "node:os";

import type { UnknownRecord } from "./types.ts";

export function resolveOption(
  options: UnknownRecord | undefined,
  optionName: string,
  fallback: string,
): string {
  const value = options?.[optionName];
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required for this action`);
  return value.trim();
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function defaultDataRoot(): string {
  return join(homedir(), ".local", "share", "opencode", "continuous-learning");
}

export function nowISO(): string {
  return new Date().toISOString();
}
