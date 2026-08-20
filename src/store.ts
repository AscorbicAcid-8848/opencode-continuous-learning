import {
  type LearningConfig,
  type MemoryTarget,
  type SkillOwner,
} from "./config.ts";
import { MemoryStore } from "./memory.ts";
import { SkillStore } from "./skill.ts";
import {
  type ReviewCheckpoint,
  type ReviewState,
  ReviewStateStore,
} from "./review.ts";
import { type SkillProvenance, type SkillSummary } from "./skill.ts";

/**
 * Facade that aggregates MemoryStore, SkillStore, and ReviewStateStore
 * behind the same public interface as the original monolithic LearningStore.
 * This preserves backward compatibility with plugin.ts, tui.ts, and tests.
 */
export class LearningStore {
  readonly memoryStore: MemoryStore;
  readonly skillStore: SkillStore;
  readonly reviewStateStore: ReviewStateStore;

  constructor(
    dataRoot: string,
    skillsRoot: string,
    config: LearningConfig,
    projectRoot?: string,
  ) {
    this.memoryStore = new MemoryStore(dataRoot, config, projectRoot);
    this.skillStore = new SkillStore(dataRoot, skillsRoot, config);
    this.reviewStateStore = new ReviewStateStore(dataRoot);
  }

  // ── delegation: memory paths ──
  get dataRoot(): string {
    return this.memoryStore.dataRoot;
  }
  get memoryPath(): string {
    return this.memoryStore.memoryPath;
  }
  get userPath(): string {
    return this.memoryStore.userPath;
  }
  get projectRoot(): string | undefined {
    return this.memoryStore.projectRoot;
  }
  get projectsRoot(): string {
    return this.memoryStore.projectsRoot;
  }
  get projectMemoryPath(): string | undefined {
    return this.memoryStore.projectMemoryPath;
  }

  // ── delegation: skill paths ──
  get skillsRoot(): string {
    return this.skillStore.skillsRoot;
  }
  get provenanceRoot(): string {
    return this.skillStore.provenanceRoot;
  }
  get skillArchiveRoot(): string {
    return this.skillStore.skillArchiveRoot;
  }
  get reviewStatePath(): string {
    return this.reviewStateStore.reviewStatePath;
  }
  get config(): LearningConfig {
    return this.memoryStore.config;
  }

  async ensureLayout(): Promise<void> {
    await Promise.all([
      this.memoryStore.ensureLayout(),
      this.skillStore.ensureLayout(),
    ]);
  }

  // ── memory operations ──
  readMemory(target: MemoryTarget): Promise<string[]> {
    return this.memoryStore.readMemory(target);
  }
  addMemory(target: MemoryTarget, content: string) {
    return this.memoryStore.addMemory(target, content);
  }
  replaceMemory(target: MemoryTarget, oldText: string, content: string) {
    return this.memoryStore.replaceMemory(target, oldText, content);
  }
  removeMemory(target: MemoryTarget, oldText: string) {
    return this.memoryStore.removeMemory(target, oldText);
  }

  // ── skill operations ──
  readProvenance(name: string): Promise<SkillProvenance | undefined> {
    return this.skillStore.readProvenance(name);
  }
  listSkills(): Promise<SkillSummary[]> {
    return this.skillStore.listSkills();
  }
  viewSkill(name: string) {
    return this.skillStore.viewSkill(name);
  }
  createSkill(input: {
    name: string;
    description: string;
    content: string;
    owner: SkillOwner;
    sourceSessionID?: string;
  }) {
    return this.skillStore.createSkill(input);
  }
  updateSkill(input: {
    name: string;
    description: string;
    content: string;
    origin: SkillOwner;
    sourceSessionID?: string;
  }) {
    return this.skillStore.updateSkill(input);
  }
  deleteSkill(input: {
    name: string;
    origin: SkillOwner;
    sourceSessionID?: string;
    absorbedInto?: string;
  }) {
    return this.skillStore.deleteSkill(input);
  }

  // ── review state operations ──
  getReviewState(): Promise<ReviewState> {
    return this.reviewStateStore.getReviewState();
  }
  getCheckpoint(sessionID: string): Promise<ReviewCheckpoint> {
    return this.reviewStateStore.getCheckpoint(sessionID);
  }
  updateCheckpoint(sessionID: string, value: ReviewCheckpoint): Promise<void> {
    return this.reviewStateStore.updateCheckpoint(sessionID, value);
  }
  deleteCheckpoint(sessionID: string): Promise<void> {
    return this.reviewStateStore.deleteCheckpoint(sessionID);
  }

  async buildSystemSnapshot(): Promise<string> {
    const [memory, user, project, skills] = await Promise.all([
      this.readMemory("memory"),
      this.readMemory("user"),
      this.projectRoot ? this.readMemory("project") : Promise.resolve([]),
      this.listSkills(),
    ]);
    const renderEntries = (entries: string[]) =>
      entries.length
        ? entries.map((entry) => `- ${JSON.stringify(entry)}`).join("\n")
        : "- (empty)";
    const skillIndex = skills.length
      ? skills
          .map(
            (skill) => `- ${skill.name}: ${JSON.stringify(skill.description)}`,
          )
          .join("\n")
      : "- (none)";
    return [
      "<persistent-learning-snapshot>",
      "This snapshot is frozen for the current session. Do not assume a write changes it immediately.",
      "Use global memory only for facts that apply across projects, user for durable preferences, and project for facts specific to the active project.",
      "Save reusable procedures with learning_skill. Do not copy project-local facts into global memory.",
      "Never save secrets, transient task state, or unverified guesses. Load a relevant Skill with learning_skill view before following it.",
      "",
      "Durable memory:",
      renderEntries(memory),
      "",
      "User profile:",
      renderEntries(user),
      "",
      `Active project: ${this.projectRoot ? JSON.stringify(this.projectRoot) : "(none)"}`,
      "Project memory:",
      renderEntries(project),
      "",
      "Available learned Skills (index only):",
      skillIndex,
      "</persistent-learning-snapshot>",
    ].join("\n");
  }
}
