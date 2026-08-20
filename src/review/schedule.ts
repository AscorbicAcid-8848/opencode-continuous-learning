import { type LearningConfig } from "../config/schema.ts";
import type { ReviewCheckpoint } from "./state.ts";
import type { TranscriptItem } from "./transcript.ts";

export function countTranscript(items: TranscriptItem[]): {
  userTurns: number;
  toolCalls: number;
  lastMessageID?: string;
} {
  return {
    userTurns: items.filter((item) => item.role === "user").length,
    toolCalls: items.reduce(
      (count, item) =>
        count +
        item.toolCalls.filter((toolCall) =>
          ["completed", "error"].includes(toolCall.status),
        ).length,
      0,
    ),
    lastMessageID: items.at(-1)?.id,
  };
}

export function isReviewDue(
  counts: ReturnType<typeof countTranscript>,
  checkpoint: ReviewCheckpoint,
  config: LearningConfig,
  now = Date.now(),
): { due: boolean; memoryDue: boolean; skillDue: boolean } {
  const memoryDue =
    counts.userTurns - checkpoint.userTurns >= config.memoryEveryTurns;
  const skillDue =
    counts.toolCalls - checkpoint.toolCalls >= config.skillEveryToolCalls;
  if (!memoryDue && !skillDue) return { due: false, memoryDue, skillDue };
  if (checkpoint.lastAttemptAt && checkpoint.lastError) {
    const retryAt =
      Date.parse(checkpoint.lastAttemptAt) +
      config.retryCooldownMinutes * 60_000;
    if (Number.isFinite(retryAt) && retryAt > now)
      return { due: false, memoryDue, skillDue };
  }
  return { due: true, memoryDue, skillDue };
}
