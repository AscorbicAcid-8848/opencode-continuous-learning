import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteText } from "../shared/file-io.ts";
import { withStorageLock } from "../shared/lock.ts";
import type { UnknownRecord } from "../shared/types.ts";
import type { LearningStore } from "../store.ts";
import { intersectionSize, shortHash, tokens } from "./graph.ts";

export interface JourneyEvent {
  id: string;
  at: string;
  kind: "memory" | "skill" | "pending" | "provider";
  action: string;
  label: string;
  projectRoot?: string;
  sourceSessionID?: string;
  metadata?: UnknownRecord;
}

type JourneyState = { schemaVersion: 1; events: JourneyEvent[] };

export class LearningJourneyStore {
  readonly path: string;
  private readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    this.path = join(dataRoot, "learning-journey.json");
  }

  async append(input: Omit<JourneyEvent, "id" | "at">): Promise<JourneyEvent> {
    const event: JourneyEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
    };
    await withStorageLock(this.dataRoot, async () => {
      const state = await this.readState();
      state.events.push(event);
      if (state.events.length > 5_000)
        state.events.splice(0, state.events.length - 5_000);
      await atomicWriteText(this.path, `${JSON.stringify(state, null, 2)}\n`);
    });
    return event;
  }

  async timeline(limit = 100): Promise<JourneyEvent[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return (await this.readState()).events.slice(-safeLimit).reverse();
  }

  async graph(store: LearningStore): Promise<UnknownRecord> {
    const [memory, user, project, skills, events] = await Promise.all([
      store.readMemory("memory"),
      store.readMemory("user"),
      store.projectRoot ? store.readMemory("project") : Promise.resolve([]),
      store.listSkills(),
      this.timeline(5_000),
    ]);
    const timestamp = (kind: string, label: string) =>
      events.find((event) => event.kind === kind && event.label === label)?.at;
    const memories = [
      ...memory.map((content) => ({ target: "memory" as const, content })),
      ...user.map((content) => ({ target: "user" as const, content })),
      ...project.map((content) => ({ target: "project" as const, content })),
    ].map((item) => ({
      id: `memory:${item.target}:${shortHash(item.content)}`,
      kind: "memory",
      label: item.content,
      target: item.target,
      timestamp: timestamp("memory", item.content),
    }));
    const skillNodes = skills.map((skill) => ({
      id: `skill:${skill.name}`,
      kind: "skill",
      label: skill.name,
      description: skill.description,
      owner: skill.owner,
      autoManaged: skill.autoManaged,
      timestamp: timestamp("skill", skill.name),
    }));
    const edges: UnknownRecord[] = [];
    for (const memoryNode of memories) {
      const memoryTokens = tokens(memoryNode.label);
      const scored = skillNodes
        .map((skill) => ({
          id: skill.id,
          overlap: intersectionSize(
            memoryTokens,
            tokens(`${skill.label} ${skill.description}`),
          ),
        }))
        .filter((item) => item.overlap > 0)
        .sort((left, right) => right.overlap - left.overlap)
        .slice(0, 4);
      for (const item of scored) {
        edges.push({
          source: memoryNode.id,
          target: item.id,
          relation: "related_to",
          weight: item.overlap,
        });
      }
    }
    const ordered = [...memories, ...skillNodes]
      .filter((node) => node.timestamp)
      .sort((left, right) =>
        String(left.timestamp).localeCompare(String(right.timestamp)),
      );
    for (let index = 1; index < ordered.length; index += 1) {
      edges.push({
        source: ordered[index - 1].id,
        target: ordered[index].id,
        relation: "learned_after",
      });
    }
    return {
      nodes: [...memories, ...skillNodes],
      edges,
      stats: {
        memories: memories.length,
        skills: skillNodes.length,
        edges: edges.length,
        events: events.length,
      },
    };
  }

  private async readState(): Promise<JourneyState> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!value || typeof value !== "object")
        return { schemaVersion: 1, events: [] };
      const item = value as UnknownRecord;
      if (item.schemaVersion !== 1 || !Array.isArray(item.events))
        return { schemaVersion: 1, events: [] };
      return value as JourneyState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, events: [] };
      throw error;
    }
  }
}
