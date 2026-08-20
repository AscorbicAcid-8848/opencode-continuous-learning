import { join } from "node:path";

import { type LearningConfig } from "./config.ts";
import {
  atomicWriteText,
  readJSON,
  withStorageLock,
  truncate,
} from "./shared.ts";

export interface ReviewCheckpoint {
  userTurns: number;
  toolCalls: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastMessageID?: string;
}

export interface ReviewState {
  schemaVersion: 1;
  sessions: Record<string, ReviewCheckpoint>;
}

export class ReviewStateStore {
  readonly reviewStatePath: string;
  private readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    this.reviewStatePath = join(dataRoot, "review-state.json");
  }

  async getReviewState(): Promise<ReviewState> {
    const value = await readJSON<unknown>(this.reviewStatePath, undefined);
    if (!value || typeof value !== "object")
      return { schemaVersion: 1, sessions: {} };
    const item = value as Record<string, unknown>;
    if (
      item.schemaVersion !== 1 ||
      !item.sessions ||
      typeof item.sessions !== "object"
    ) {
      return { schemaVersion: 1, sessions: {} };
    }
    return value as ReviewState;
  }

  async getCheckpoint(sessionID: string): Promise<ReviewCheckpoint> {
    return (
      (await this.getReviewState()).sessions[sessionID] ?? {
        userTurns: 0,
        toolCalls: 0,
      }
    );
  }

  async updateCheckpoint(
    sessionID: string,
    value: ReviewCheckpoint,
  ): Promise<void> {
    await withStorageLock(this.dataRoot, async () => {
      const state = await this.getReviewState();
      state.sessions[sessionID] = value;
      await atomicWriteText(
        this.reviewStatePath,
        `${JSON.stringify(state, null, 2)}\n`,
      );
    });
  }

  async deleteCheckpoint(sessionID: string): Promise<void> {
    await withStorageLock(this.dataRoot, async () => {
      const state = await this.getReviewState();
      if (!(sessionID in state.sessions)) return;
      delete state.sessions[sessionID];
      await atomicWriteText(
        this.reviewStatePath,
        `${JSON.stringify(state, null, 2)}\n`,
      );
    });
  }
}

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: Array<{
    name: string;
    status: string;
    input?: unknown;
    output?: string;
  }>;
}

export function renderTranscript(
  items: TranscriptItem[],
  maxCharacters: number,
): string {
  const chunks = items.map((item) => {
    const lines = [
      `[${item.role.toUpperCase()} ${item.id}]`,
      item.text || "(no text)",
    ];
    for (const call of item.toolCalls) {
      const input =
        call.input === undefined
          ? ""
          : ` input=${truncate(JSON.stringify(call.input), 1_500)}`;
      const output = call.output ? `\n${truncate(call.output, 2_500)}` : "";
      lines.push(`[TOOL ${call.name} ${call.status}]${input}${output}`);
    }
    return lines.join("\n");
  });
  const selected: string[] = [];
  let used = 0;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = truncate(chunks[index], maxCharacters);
    if (selected.length && used + chunk.length + 2 > maxCharacters) break;
    selected.unshift(chunk);
    used += chunk.length + 2;
  }
  return selected.join("\n\n");
}

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
