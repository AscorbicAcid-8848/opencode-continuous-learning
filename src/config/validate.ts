import {
  CONFIG_FIELD_SPECS,
  DEFAULT_CONFIG,
  type LearningConfig,
  type LearningConfigKey,
} from "./schema.ts";

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
