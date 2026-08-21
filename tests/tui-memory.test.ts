import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { PendingWriteStore } from "../src/pending.ts";
import { LearningStore } from "../src/store.ts";
import { showPanel, default as tuiModule } from "../src/tui.ts";

type UnknownRecord = Record<string, unknown>;

type MockApi = {
  state: { path: { config: string; directory?: string; worktree?: string } };
  keymap: { registerLayer(value: UnknownRecord): () => void };
  lifecycle: { onDispose(value: () => void): () => void };
  ui: {
    dialog: {
      size: string;
      depth: number;
      open: boolean;
      setSize(): void;
      clear(): void;
      replace(render: () => unknown): void;
    };
    toast(value: UnknownRecord): void;
    DialogSelect(props: UnknownRecord): UnknownRecord;
    DialogPrompt(props: UnknownRecord): UnknownRecord;
    DialogConfirm(props: UnknownRecord): UnknownRecord;
    DialogAlert(props: UnknownRecord): UnknownRecord;
  };
};

interface MockHarness {
  api: MockApi;
  renders: UnknownRecord[];
  toasts: UnknownRecord[];
  root: string;
  configPath: string;
  paths: {
    dataRoot: string;
    skillsRoot: string;
    projectRoot: string;
    projectRootActive: boolean;
  };
}

async function createHarness(
  options: { withProject?: boolean } = {},
): Promise<MockHarness> {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-tui-mem-"));
  const configPath = join(root, "continuous-learning", "config.json");
  const renders: UnknownRecord[] = [];
  const toasts: UnknownRecord[] = [];
  await mkdir(join(root, "continuous-learning"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ ...DEFAULT_CONFIG }, null, 2)}\n`,
  );
  const projectDir = join(root, "project");
  if (options.withProject) await mkdir(projectDir, { recursive: true });
  const dialog = {
    size: "medium",
    depth: 0,
    open: false,
    setSize() {},
    clear() {},
    replace(render: () => unknown) {
      renders.push(render() as UnknownRecord);
    },
  };
  const api: MockApi = {
    state: {
      path: {
        config: root,
        ...(options.withProject ? { directory: projectDir } : {}),
      },
    },
    keymap: {
      registerLayer() {
        return () => undefined;
      },
    },
    lifecycle: {
      onDispose() {
        return () => undefined;
      },
    },
    ui: {
      dialog,
      toast(value: UnknownRecord) {
        toasts.push(value);
      },
      DialogSelect(props: UnknownRecord) {
        return { kind: "select", ...props };
      },
      DialogPrompt(props: UnknownRecord) {
        return { kind: "prompt", ...props };
      },
      DialogConfirm(props: UnknownRecord) {
        return { kind: "confirm", ...props };
      },
      DialogAlert(props: UnknownRecord) {
        return { kind: "alert", ...props };
      },
    },
  };
  const paths = {
    dataRoot: join(root, "data"),
    skillsRoot: join(root, "skills"),
    projectRoot: projectDir,
    projectRootActive: Boolean(options.withProject),
  };
  return { api, renders, toasts, root, configPath, paths };
}

async function openPanel(
  harness: MockHarness,
  paths?: MockHarness["paths"],
): Promise<void> {
  await showPanel(
    harness.api as never,
    harness.api.ui.dialog as never,
    harness.configPath,
    paths ?? harness.paths,
  );
}

function lastRender(harness: MockHarness): UnknownRecord {
  return harness.renders.at(-1) as UnknownRecord;
}

function optionsOf(render: UnknownRecord): UnknownRecord[] {
  return render.options as UnknownRecord[];
}

function findOption(
  render: UnknownRecord,
  predicate: (option: UnknownRecord) => boolean,
): UnknownRecord | undefined {
  return optionsOf(render).find(predicate);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function selectOption(
  render: UnknownRecord,
  predicate: (option: UnknownRecord) => boolean,
): Promise<void> {
  const option = findOption(render, predicate);
  assert.ok(option, "expected to find a matching option");
  const result = (render.onSelect as (option: UnknownRecord) => unknown)(
    option as UnknownRecord,
  );
  if (result instanceof Promise) await result;
  await flush();
}

async function confirmPrompt(
  render: UnknownRecord,
  value: string,
): Promise<void> {
  const result = (render.onConfirm as (value: string) => unknown)(value);
  if (result instanceof Promise) await result;
  await flush();
}

async function confirmAlert(render: UnknownRecord): Promise<void> {
  const result = (render.onConfirm as () => unknown)();
  if (result instanceof Promise) await result;
  await flush();
}

function findBrowsingOption(
  render: UnknownRecord,
  title: string,
): UnknownRecord | undefined {
  return findOption(
    render,
    (option) => option.title === title && option.category === "浏览",
  );
}

async function snapshotFiles(
  harness: MockHarness,
): Promise<Record<string, string | null>> {
  const candidates = [
    join(harness.paths.dataRoot, "MEMORY.md"),
    join(harness.paths.dataRoot, "USER.md"),
    join(harness.paths.dataRoot, "projects"),
    join(harness.paths.dataRoot, "skill-provenance"),
    join(harness.paths.dataRoot, "pending"),
    join(harness.paths.dataRoot, "learning-journey.json"),
    harness.configPath,
    harness.paths.skillsRoot,
  ];
  const snapshot: Record<string, string | null> = {};
  for (const candidate of candidates) {
    snapshot[candidate] = await readOrNull(candidate);
  }
  return snapshot;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return `[DIR]`;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeManagedMemory(
  store: LearningStore,
  target: "memory" | "user" | "project",
  entries: string[],
): Promise<void> {
  for (const entry of entries) await store.addMemory(target, entry);
}

test("root panel lists four browsing entries", async () => {
  const harness = await createHarness();
  try {
    await openPanel(harness);
    const root = lastRender(harness);
    assert.equal(root.kind, "select");
    assert.equal(optionsOf(root).length, 28);
    const titles = ["记忆浏览", "记忆搜索", "Skill 浏览", "全局概览"];
    for (const title of titles) {
      const option = findBrowsingOption(root, title);
      assert.ok(option, `expected root to contain ${title}`);
      assert.equal(option?.category, "浏览");
    }
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("no new slash commands registered", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-tui-mem-cmd-"));
  try {
    const configPath = join(root, "continuous-learning", "config.json");
    await mkdir(join(root, "continuous-learning"), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ ...DEFAULT_CONFIG }, null, 2)}\n`,
    );
    let layer: UnknownRecord | undefined;
    const api: MockApi = {
      state: { path: { config: root } },
      keymap: {
        registerLayer(value: UnknownRecord) {
          layer = value;
          return () => undefined;
        },
      },
      lifecycle: { onDispose: () => () => undefined },
      ui: {
        dialog: {
          size: "medium",
          depth: 0,
          open: false,
          setSize() {},
          clear() {},
          replace() {},
        },
        toast() {},
        DialogSelect(props: UnknownRecord) {
          return { kind: "select", ...props };
        },
        DialogPrompt(props: UnknownRecord) {
          return { kind: "prompt", ...props };
        },
        DialogConfirm(props: UnknownRecord) {
          return { kind: "confirm", ...props };
        },
        DialogAlert(props: UnknownRecord) {
          return { kind: "alert", ...props };
        },
      },
    };
    await tuiModule.tui(
      api as never,
      {
        configPath,
        dataRoot: join(root, "data"),
        skillsRoot: join(root, "skills"),
      } as never,
      {} as never,
    );
    assert.ok(layer);
    const commands = layer!.commands as UnknownRecord[];
    assert.deepEqual(
      commands.map((command) => command.slashName),
      ["learning-settings", "learning-pending", "learning-journey"],
    );
    assert.equal(commands.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("palette command opens the same root", async () => {
  const harness = await createHarness();
  try {
    await openPanel(harness);
    const root = lastRender(harness);
    assert.equal(root.kind, "select");
    assert.match(String(root.title), /持续学习设置/u);
    assert.equal(optionsOf(root).length, 28);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("memory scope list shows all scopes", async () => {
  const harness = await createHarness();
  try {
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    const scopes = lastRender(harness);
    assert.equal(scopes.kind, "select");
    const titles = optionsOf(scopes).map((o) => o.title);
    assert.ok(titles.includes("全局记忆"));
    assert.ok(titles.includes("用户画像"));
    assert.ok(titles.includes("项目记忆"));
    assert.ok(titles.includes("返回设置"));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("memory entries list shows every entry one per row", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000", "Uses TypeScript"]);
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    await selectOption(lastRender(harness), (o) => o.title === "全局记忆");
    const entries = lastRender(harness);
    assert.equal(entries.kind, "select");
    const entryOptions = optionsOf(entries).filter((o) => o.value !== "back");
    assert.equal(entryOptions.length, 2);
    assert.ok(entryOptions.some((o) => String(o.title).includes("Port 3000")));
    assert.ok(
      entryOptions.some((o) => String(o.title).includes("Uses TypeScript")),
    );
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("selecting an entry shows full text detail", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    await selectOption(lastRender(harness), (o) => o.title === "全局记忆");
    await selectOption(lastRender(harness), (o) =>
      String(o.title).includes("Port 3000"),
    );
    const detail = lastRender(harness);
    assert.equal(detail.kind, "alert");
    assert.ok(String(detail.message).includes("Port 3000"));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("project scope marked unavailable without active project root", async () => {
  const harness = await createHarness();
  try {
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    const scopes = lastRender(harness);
    const projectOption = findOption(scopes, (o) => o.title === "项目记忆");
    assert.ok(projectOption);
    assert.match(String(projectOption!.footer), /不可用/u);
    await selectOption(scopes, (o) => o.title === "项目记忆");
    const alert = lastRender(harness);
    assert.equal(alert.kind, "alert");
    assert.match(String(alert.message), /项目记忆.*不可用/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("memory search returns matching entries labeled with scope", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await writeManagedMemory(store, "user", ["Prefers concise output"]);
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆搜索");
    const prompt = lastRender(harness);
    assert.equal(prompt.kind, "prompt");
    await confirmPrompt(prompt, "port");
    const results = lastRender(harness);
    assert.equal(results.kind, "select");
    const matchOptions = optionsOf(results).filter((o) => o.value !== "back");
    assert.equal(matchOptions.length, 1);
    assert.ok(String(matchOptions[0].title).includes("Port 3000"));
    assert.match(String(matchOptions[0].footer), /全局记忆/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("memory search is case insensitive", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆搜索");
    const prompt = lastRender(harness);
    await confirmPrompt(prompt, "PORT");
    const results = lastRender(harness);
    const matchOptions = optionsOf(results).filter((o) => o.value !== "back");
    assert.equal(matchOptions.length, 1);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("memory search shows empty state on no match", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆搜索");
    const prompt = lastRender(harness);
    await confirmPrompt(prompt, "nonexistent-keyword");
    const empty = lastRender(harness);
    assert.equal(empty.kind, "alert");
    assert.match(String(empty.message), /无匹配/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("memory search spans all available scopes", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await writeManagedMemory(store, "user", ["Port 3000 preference"]);
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆搜索");
    const prompt = lastRender(harness);
    await confirmPrompt(prompt, "port");
    const results = lastRender(harness);
    const matchOptions = optionsOf(results).filter((o) => o.value !== "back");
    assert.equal(matchOptions.length, 2);
    const footers = matchOptions.map((o) => String(o.footer));
    assert.ok(footers.some((f) => f.includes("全局记忆")));
    assert.ok(footers.some((f) => f.includes("用户画像")));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("skill list shows owner and autoManaged flag", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy the app",
      content: "# Deploy\n\nRun pnpm deploy",
      owner: "agent",
    });
    await store.createSkill({
      name: "coding-style",
      description: "User coding preferences",
      content: "# Style\n\nUse tabs",
      owner: "user",
    });
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    const skills = lastRender(harness);
    assert.equal(skills.kind, "select");
    const skillOptions = optionsOf(skills).filter(
      (o) => o.value !== "back" && o.value !== "filter" && o.value !== "clear",
    );
    assert.equal(skillOptions.length, 2);
    const deploy = skillOptions.find((o) => o.title === "deploy-workflow");
    assert.ok(deploy);
    assert.match(String(deploy!.footer), /agent/u);
    assert.match(String(deploy!.footer), /是/u);
    const style = skillOptions.find((o) => o.title === "coding-style");
    assert.ok(style);
    assert.match(String(style!.footer), /user/u);
    assert.match(String(style!.footer), /否/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("skill filter by keyword matches name or description", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy the app",
      content: "# Deploy",
      owner: "agent",
    });
    await store.createSkill({
      name: "coding-style",
      description: "User coding preferences",
      content: "# Style",
      owner: "user",
    });
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await selectOption(lastRender(harness), (o) => o.value === "filter");
    const prompt = lastRender(harness);
    assert.equal(prompt.kind, "prompt");
    await confirmPrompt(prompt, "deploy");
    const filtered = lastRender(harness);
    const skillOptions = optionsOf(filtered).filter(
      (o) => o.value !== "back" && o.value !== "filter" && o.value !== "clear",
    );
    assert.equal(skillOptions.length, 1);
    assert.equal(skillOptions[0].title, "deploy-workflow");

    await selectOption(filtered, (o) => o.value === "clear");
    const cleared = lastRender(harness);
    const allOptions = optionsOf(cleared).filter(
      (o) => o.value !== "back" && o.value !== "filter" && o.value !== "clear",
    );
    assert.equal(allOptions.length, 2);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("skill filter matches description not just name", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy the app",
      content: "# Deploy",
      owner: "agent",
    });
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await selectOption(lastRender(harness), (o) => o.value === "filter");
    const prompt = lastRender(harness);
    await confirmPrompt(prompt, "app");
    const filtered = lastRender(harness);
    const skillOptions = optionsOf(filtered).filter(
      (o) => o.value !== "back" && o.value !== "filter" && o.value !== "clear",
    );
    assert.equal(skillOptions.length, 1);
    assert.equal(skillOptions[0].title, "deploy-workflow");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("skill detail shows content and provenance without mutating", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy the app",
      content: "# Deploy\n\nRun pnpm deploy",
      owner: "agent",
    });
    const skillPath = join(
      harness.paths.skillsRoot,
      "deploy-workflow",
      "SKILL.md",
    );
    const provenancePath = join(
      harness.paths.dataRoot,
      "skill-provenance",
      "deploy-workflow.json",
    );
    const skillBefore = await readFile(skillPath, "utf8");
    const provenanceBefore = await readFile(provenancePath, "utf8");
    const provenanceObjBefore = JSON.parse(provenanceBefore) as {
      lastUsedAt?: string;
      updatedAt: string;
    };
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await selectOption(
      lastRender(harness),
      (o) => o.title === "deploy-workflow",
    );
    const detail = lastRender(harness);
    assert.equal(detail.kind, "alert");
    assert.ok(String(detail.message).includes("SKILL.md"));
    assert.ok(String(detail.message).includes("Run pnpm deploy"));
    assert.ok(String(detail.message).includes("Provenance"));

    const skillAfter = await readFile(skillPath, "utf8");
    const provenanceAfter = await readFile(provenancePath, "utf8");
    const provenanceObjAfter = JSON.parse(provenanceAfter) as {
      lastUsedAt?: string;
      updatedAt: string;
    };
    assert.equal(skillAfter, skillBefore);
    assert.equal(provenanceAfter, provenanceBefore);
    assert.equal(provenanceObjAfter.lastUsedAt, provenanceObjBefore.lastUsedAt);
    assert.equal(provenanceObjAfter.updatedAt, provenanceObjBefore.updatedAt);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("overview shows counts provider mode and paths", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000", "Uses TypeScript"]);
    await writeManagedMemory(store, "user", ["Prefers concise output"]);
    await writeManagedMemory(store, "project", ["Project uses React"]);
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy",
      content: "# Deploy",
      owner: "agent",
    });
    await new PendingWriteStore(harness.paths.dataRoot).stage({
      summary: "remember the project port",
      origin: "background_review",
      projectRoot: harness.paths.projectRoot,
      payload: {
        kind: "memory",
        action: "add",
        target: "project",
        content: "Port 3000",
      },
    });
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "全局概览");
    const overview = lastRender(harness);
    assert.equal(overview.kind, "alert");
    const message = String(overview.message);
    assert.match(message, /全局记忆：2/u);
    assert.match(message, /用户画像：1/u);
    assert.match(message, /项目记忆：1/u);
    assert.match(message, /Skill 数量：1/u);
    assert.match(message, /待审批写入：1/u);
    assert.match(message, /builtin/u);
    assert.match(message, /持续学习：开/u);
    assert.match(message, /后台自动复盘：开/u);
    assert.ok(message.includes(harness.paths.dataRoot));
    assert.ok(message.includes(harness.paths.skillsRoot));
    assert.ok(message.includes(harness.configPath));
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("overview flags non-builtin provider without credentials as not configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-tui-mem-ext-"));
  try {
    const configPath = join(root, "continuous-learning", "config.json");
    await mkdir(join(root, "continuous-learning"), { recursive: true });
    const config = {
      ...DEFAULT_CONFIG,
      externalMemoryProvider: "mem0" as const,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const renders: UnknownRecord[] = [];
    const dialog = {
      size: "medium",
      depth: 0,
      open: false,
      setSize() {},
      clear() {},
      replace(render: () => unknown) {
        renders.push(render() as UnknownRecord);
      },
    };
    const api: MockApi = {
      state: { path: { config: root, directory: join(root, "project") } },
      keymap: { registerLayer: () => () => undefined },
      lifecycle: { onDispose: () => () => undefined },
      ui: {
        dialog,
        toast() {},
        DialogSelect(props: UnknownRecord) {
          return { kind: "select", ...props };
        },
        DialogPrompt(props: UnknownRecord) {
          return { kind: "prompt", ...props };
        },
        DialogConfirm(props: UnknownRecord) {
          return { kind: "confirm", ...props };
        },
        DialogAlert(props: UnknownRecord) {
          return { kind: "alert", ...props };
        },
      },
    };
    const paths = {
      dataRoot: join(root, "data"),
      skillsRoot: join(root, "skills"),
      projectRoot: join(root, "project"),
      projectRootActive: true,
    };
    await mkdir(join(root, "project"), { recursive: true });
    delete process.env.MEM0_API_KEY;
    delete process.env.MEM0_HOST;
    await showPanel(api as never, api.ui.dialog as never, configPath, paths);
    const root2 = renders.at(-1) as UnknownRecord;
    await selectOption(root2, (o) => o.title === "全局概览");
    const overview = renders.at(-1) as UnknownRecord;
    const message = String(overview.message);
    assert.match(message, /mem0/u);
    assert.match(message, /未完全配置/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browsing sections do not mutate any persisted file", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await writeManagedMemory(store, "user", ["Prefers concise"]);
    await writeManagedMemory(store, "project", ["Project uses React"]);
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy",
      content: "# Deploy",
      owner: "agent",
    });
    await new PendingWriteStore(harness.paths.dataRoot).stage({
      summary: "pending write",
      origin: "background_review",
      projectRoot: harness.paths.projectRoot,
      payload: {
        kind: "memory",
        action: "add",
        target: "memory",
        content: "Temp",
      },
    });
    const before = await snapshotFiles(harness);

    await openPanel(harness);

    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    await selectOption(lastRender(harness), (o) => o.title === "全局记忆");
    await selectOption(lastRender(harness), (o) =>
      String(o.title).includes("Port 3000"),
    );
    await confirmAlert(lastRender(harness));
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");

    await selectOption(lastRender(harness), (o) => o.title === "记忆搜索");
    await confirmPrompt(lastRender(harness), "port");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");

    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await selectOption(
      lastRender(harness),
      (o) => o.title === "deploy-workflow",
    );
    await confirmAlert(lastRender(harness));
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");

    await selectOption(lastRender(harness), (o) => o.title === "全局概览");
    await confirmAlert(lastRender(harness));

    const after = await snapshotFiles(harness);
    for (const [path, beforeContent] of Object.entries(before)) {
      assert.equal(after[path], beforeContent, `file changed: ${path}`);
    }
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("browsing does not create a write lock", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy",
      content: "# Deploy",
      owner: "agent",
    });
    const lockPath = join(harness.paths.dataRoot, ".write.lock");
    assert.equal(await readOrNull(lockPath), null);

    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    await selectOption(lastRender(harness), (o) => o.title === "全局记忆");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await selectOption(
      lastRender(harness),
      (o) => o.title === "deploy-workflow",
    );
    await confirmAlert(lastRender(harness));
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    await selectOption(lastRender(harness), (o) => o.title === "全局概览");
    await confirmAlert(lastRender(harness));

    assert.equal(await readOrNull(lockPath), null);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("detail onConfirm returns to parent list", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy",
      content: "# Deploy",
      owner: "agent",
    });
    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    await selectOption(lastRender(harness), (o) => o.title === "全局记忆");
    await selectOption(lastRender(harness), (o) =>
      String(o.title).includes("Port 3000"),
    );
    const detail = lastRender(harness);
    assert.equal(detail.kind, "alert");
    await confirmAlert(detail);
    const parent = lastRender(harness);
    assert.equal(parent.kind, "select");
    assert.match(String(parent.title), /全局记忆/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("section back returns to root", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    const store = new LearningStore(
      harness.paths.dataRoot,
      harness.paths.skillsRoot,
      DEFAULT_CONFIG,
      harness.paths.projectRoot,
    );
    await store.ensureLayout();
    await writeManagedMemory(store, "memory", ["Port 3000"]);
    await store.createSkill({
      name: "deploy-workflow",
      description: "How to deploy",
      content: "# Deploy",
      owner: "agent",
    });

    await openPanel(harness);
    await selectOption(lastRender(harness), (o) => o.title === "记忆浏览");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    let rootRender = lastRender(harness);
    assert.equal(rootRender.kind, "select");
    assert.match(String(rootRender.title), /持续学习设置/u);
    assert.equal(optionsOf(rootRender).length, 28);

    await selectOption(lastRender(harness), (o) => o.title === "记忆搜索");
    await confirmPrompt(lastRender(harness), "port");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    rootRender = lastRender(harness);
    assert.equal(rootRender.kind, "select");
    assert.match(String(rootRender.title), /持续学习设置/u);
    assert.equal(optionsOf(rootRender).length, 28);

    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await selectOption(lastRender(harness), (o) => o.title === "返回设置");
    rootRender = lastRender(harness);
    assert.equal(rootRender.kind, "select");
    assert.match(String(rootRender.title), /持续学习设置/u);
    assert.equal(optionsOf(rootRender).length, 28);

    await selectOption(lastRender(harness), (o) => o.title === "全局概览");
    await confirmAlert(lastRender(harness));
    rootRender = lastRender(harness);
    assert.equal(rootRender.kind, "select");
    assert.match(String(rootRender.title), /持续学习设置/u);
    assert.equal(optionsOf(rootRender).length, 28);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("storage read error shows toast and keeps panel usable", async () => {
  const harness = await createHarness({ withProject: true });
  try {
    await mkdir(harness.paths.dataRoot, { recursive: true });
    const blockerPath = join(harness.paths.dataRoot, "skills-blocker");
    await writeFile(blockerPath, "not a directory");
    const badPaths = {
      ...harness.paths,
      skillsRoot: blockerPath,
    };
    await openPanel(harness, badPaths);
    await selectOption(lastRender(harness), (o) => o.title === "Skill 浏览");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(harness.toasts.length > 0);
    const lastToast = harness.toasts.at(-1) as UnknownRecord;
    assert.equal(lastToast.variant, "error");
    const rootRender = lastRender(harness);
    assert.equal(rootRender.kind, "select");
    assert.match(String(rootRender.title), /持续学习设置/u);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});
