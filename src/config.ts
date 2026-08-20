import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { atomicWriteText } from "./shared.ts";

// ── types ────────────────────────────────────────────────────────────

export type MemoryTarget = "memory" | "user" | "project";
export type SkillOwner = "user" | "agent";
export type ExternalMemoryProviderName = "builtin" | "mem0" | "honcho";

export interface LearningConfig {
  enabled: boolean;
  memoryContextEnabled: boolean;
  autoReview: boolean;
  sessionSearchMaxSessions: number;
  backgroundWriteApproval: boolean;
  externalMemoryProvider: ExternalMemoryProviderName;
  externalMemoryAutoSync: boolean;
  externalMemoryTopK: number;
  externalMemoryTimeoutMs: number;
  memoryEveryTurns: number;
  skillEveryToolCalls: number;
  retryCooldownMinutes: number;
  maxConcurrentReviews: number;
  maxTranscriptChars: number;
  memoryCharLimit: number;
  projectMemoryCharLimit: number;
  userCharLimit: number;
  foregroundWriteApproval: boolean;
  deleteReviewSessions: boolean;
  showNotifications: boolean;
}

// ── defaults & field specs ───────────────────────────────────────────

export const DEFAULT_CONFIG: LearningConfig = {
  enabled: true,
  memoryContextEnabled: true,
  autoReview: true,
  sessionSearchMaxSessions: 200,
  backgroundWriteApproval: false,
  externalMemoryProvider: "builtin",
  externalMemoryAutoSync: true,
  externalMemoryTopK: 5,
  externalMemoryTimeoutMs: 3_000,
  memoryEveryTurns: 10,
  skillEveryToolCalls: 15,
  retryCooldownMinutes: 30,
  maxConcurrentReviews: 2,
  maxTranscriptChars: 60_000,
  memoryCharLimit: 2_200,
  projectMemoryCharLimit: 4_000,
  userCharLimit: 1_375,
  foregroundWriteApproval: true,
  deleteReviewSessions: true,
  showNotifications: true,
};

export type LearningConfigKey = keyof LearningConfig;

export type LearningConfigFieldSpec =
  | { kind: "boolean"; default: boolean }
  | { kind: "integer"; default: number; minimum: number; maximum: number }
  | { kind: "enum"; default: string; values: readonly string[] };

export const CONFIG_FIELD_SPECS: Record<
  LearningConfigKey,
  LearningConfigFieldSpec
> = {
  enabled: { kind: "boolean", default: DEFAULT_CONFIG.enabled },
  memoryContextEnabled: {
    kind: "boolean",
    default: DEFAULT_CONFIG.memoryContextEnabled,
  },
  autoReview: { kind: "boolean", default: DEFAULT_CONFIG.autoReview },
  sessionSearchMaxSessions: {
    kind: "integer",
    default: DEFAULT_CONFIG.sessionSearchMaxSessions,
    minimum: 10,
    maximum: 2_000,
  },
  backgroundWriteApproval: {
    kind: "boolean",
    default: DEFAULT_CONFIG.backgroundWriteApproval,
  },
  externalMemoryProvider: {
    kind: "enum",
    default: DEFAULT_CONFIG.externalMemoryProvider,
    values: ["builtin", "mem0", "honcho"],
  },
  externalMemoryAutoSync: {
    kind: "boolean",
    default: DEFAULT_CONFIG.externalMemoryAutoSync,
  },
  externalMemoryTopK: {
    kind: "integer",
    default: DEFAULT_CONFIG.externalMemoryTopK,
    minimum: 1,
    maximum: 50,
  },
  externalMemoryTimeoutMs: {
    kind: "integer",
    default: DEFAULT_CONFIG.externalMemoryTimeoutMs,
    minimum: 500,
    maximum: 30_000,
  },
  memoryEveryTurns: {
    kind: "integer",
    default: DEFAULT_CONFIG.memoryEveryTurns,
    minimum: 1,
    maximum: 1_000,
  },
  skillEveryToolCalls: {
    kind: "integer",
    default: DEFAULT_CONFIG.skillEveryToolCalls,
    minimum: 1,
    maximum: 10_000,
  },
  retryCooldownMinutes: {
    kind: "integer",
    default: DEFAULT_CONFIG.retryCooldownMinutes,
    minimum: 1,
    maximum: 24 * 60,
  },
  maxConcurrentReviews: {
    kind: "integer",
    default: DEFAULT_CONFIG.maxConcurrentReviews,
    minimum: 1,
    maximum: 8,
  },
  maxTranscriptChars: {
    kind: "integer",
    default: DEFAULT_CONFIG.maxTranscriptChars,
    minimum: 4_000,
    maximum: 500_000,
  },
  memoryCharLimit: {
    kind: "integer",
    default: DEFAULT_CONFIG.memoryCharLimit,
    minimum: 500,
    maximum: 100_000,
  },
  projectMemoryCharLimit: {
    kind: "integer",
    default: DEFAULT_CONFIG.projectMemoryCharLimit,
    minimum: 500,
    maximum: 100_000,
  },
  userCharLimit: {
    kind: "integer",
    default: DEFAULT_CONFIG.userCharLimit,
    minimum: 500,
    maximum: 100_000,
  },
  foregroundWriteApproval: {
    kind: "boolean",
    default: DEFAULT_CONFIG.foregroundWriteApproval,
  },
  deleteReviewSessions: {
    kind: "boolean",
    default: DEFAULT_CONFIG.deleteReviewSessions,
  },
  showNotifications: {
    kind: "boolean",
    default: DEFAULT_CONFIG.showNotifications,
  },
};

export const CONFIG_FIELD_KEYS = Object.keys(
  CONFIG_FIELD_SPECS,
) as LearningConfigKey[];

export const RETIRED_CONFIG_FIELDS = [
  "sessionSearchEnabled",
  "learningJourneyEnabled",
  "skillDeleteEnabled",
] as const;

// ── paths ────────────────────────────────────────────────────────────

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

// ── coercion helpers ─────────────────────────────────────────────────

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function coerceInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function coerceEnum<T extends string>(
  value: unknown,
  fallback: T,
  values: readonly T[],
): T {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
}

// ── validation ───────────────────────────────────────────────────────

export function normalizeConfig(value: unknown): LearningConfig {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: coerceBoolean(raw.enabled, DEFAULT_CONFIG.enabled),
    memoryContextEnabled: coerceBoolean(
      raw.memoryContextEnabled,
      DEFAULT_CONFIG.memoryContextEnabled,
    ),
    autoReview: coerceBoolean(raw.autoReview, DEFAULT_CONFIG.autoReview),
    sessionSearchMaxSessions: coerceInteger(
      raw.sessionSearchMaxSessions,
      DEFAULT_CONFIG.sessionSearchMaxSessions,
      10,
      2_000,
    ),
    backgroundWriteApproval: coerceBoolean(
      raw.backgroundWriteApproval,
      DEFAULT_CONFIG.backgroundWriteApproval,
    ),
    externalMemoryProvider: coerceEnum(
      raw.externalMemoryProvider,
      DEFAULT_CONFIG.externalMemoryProvider,
      ["builtin", "mem0", "honcho"],
    ),
    externalMemoryAutoSync: coerceBoolean(
      raw.externalMemoryAutoSync,
      DEFAULT_CONFIG.externalMemoryAutoSync,
    ),
    externalMemoryTopK: coerceInteger(
      raw.externalMemoryTopK,
      DEFAULT_CONFIG.externalMemoryTopK,
      1,
      50,
    ),
    externalMemoryTimeoutMs: coerceInteger(
      raw.externalMemoryTimeoutMs,
      DEFAULT_CONFIG.externalMemoryTimeoutMs,
      500,
      30_000,
    ),
    memoryEveryTurns: coerceInteger(
      raw.memoryEveryTurns,
      DEFAULT_CONFIG.memoryEveryTurns,
      1,
      1_000,
    ),
    skillEveryToolCalls: coerceInteger(
      raw.skillEveryToolCalls,
      DEFAULT_CONFIG.skillEveryToolCalls,
      1,
      10_000,
    ),
    retryCooldownMinutes: coerceInteger(
      raw.retryCooldownMinutes,
      DEFAULT_CONFIG.retryCooldownMinutes,
      1,
      24 * 60,
    ),
    maxConcurrentReviews: coerceInteger(
      raw.maxConcurrentReviews,
      DEFAULT_CONFIG.maxConcurrentReviews,
      1,
      8,
    ),
    maxTranscriptChars: coerceInteger(
      raw.maxTranscriptChars,
      DEFAULT_CONFIG.maxTranscriptChars,
      4_000,
      500_000,
    ),
    memoryCharLimit: coerceInteger(
      raw.memoryCharLimit,
      DEFAULT_CONFIG.memoryCharLimit,
      500,
      100_000,
    ),
    projectMemoryCharLimit: coerceInteger(
      raw.projectMemoryCharLimit,
      DEFAULT_CONFIG.projectMemoryCharLimit,
      500,
      100_000,
    ),
    userCharLimit: coerceInteger(
      raw.userCharLimit,
      DEFAULT_CONFIG.userCharLimit,
      500,
      100_000,
    ),
    foregroundWriteApproval: coerceBoolean(
      raw.foregroundWriteApproval,
      DEFAULT_CONFIG.foregroundWriteApproval,
    ),
    deleteReviewSessions: coerceBoolean(
      raw.deleteReviewSessions,
      DEFAULT_CONFIG.deleteReviewSessions,
    ),
    showNotifications: coerceBoolean(
      raw.showNotifications,
      DEFAULT_CONFIG.showNotifications,
    ),
  };
}

export function validateConfigValue(
  key: LearningConfigKey,
  value: unknown,
): LearningConfig[LearningConfigKey] {
  const spec = CONFIG_FIELD_SPECS[key];
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean")
      throw new Error(`${key} must be true or false`);
    return value as LearningConfig[LearningConfigKey];
  }
  if (spec.kind === "enum") {
    if (typeof value !== "string" || !spec.values.includes(value)) {
      throw new Error(`${key} must be one of: ${spec.values.join(", ")}`);
    }
    return value as LearningConfig[LearningConfigKey];
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  if (value < spec.minimum || value > spec.maximum) {
    throw new Error(
      `${key} must be between ${spec.minimum} and ${spec.maximum}`,
    );
  }
  return value;
}

// ── config file read/write ───────────────────────────────────────────

export async function loadConfig(path: string): Promise<LearningConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`Unable to read learning config ${path}: ${String(error)}`);
  }
}

export async function updateConfig(
  path: string,
  patch: Partial<LearningConfig>,
): Promise<LearningConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object");
    }
    raw = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Unable to update learning config ${path}: ${String(error)}`,
      );
    }
  }
  for (const key of RETIRED_CONFIG_FIELDS) delete raw[key];
  for (const [rawKey, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELD_SPECS, rawKey)) {
      throw new Error(`Unknown learning config field: ${rawKey}`);
    }
    const key = rawKey as LearningConfigKey;
    raw[key] = validateConfigValue(key, value);
  }
  await atomicWriteText(path, `${JSON.stringify(raw, null, 2)}\n`);
  return normalizeConfig(raw);
}

export async function pruneRetiredConfigFields(path: string): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the root value must be a JSON object");
    }
    raw = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `Unable to migrate learning config ${path}: ${String(error)}`,
    );
  }
  let changed = false;
  for (const key of RETIRED_CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    delete raw[key];
    changed = true;
  }
  if (changed) await atomicWriteText(path, `${JSON.stringify(raw, null, 2)}\n`);
  return changed;
}

export async function resetConfig(path: string): Promise<LearningConfig> {
  return updateConfig(path, DEFAULT_CONFIG);
}

export async function setConfigEnabled(
  path: string,
  enabled: boolean,
): Promise<void> {
  await updateConfig(path, { enabled });
}
