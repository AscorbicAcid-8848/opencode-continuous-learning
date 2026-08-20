import { join } from "node:path";

import { atomicWriteText, readJSON } from "../shared/file-io.ts";
import { withStorageLock } from "../shared/lock.ts";

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
