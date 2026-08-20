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
