import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { LearningJourneyStore } from "../src/journey.ts";
import { PendingWriteStore } from "../src/pending.ts";
import tuiModule from "../src/tui.ts";

type UnknownRecord = Record<string, unknown>;

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the settings panel update");
}

test("TUI panel registers a slash command and edits, validates, and resets settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-learning-tui-test-"));
  const configPath = join(root, "continuous-learning", "config.json");
  const renders: UnknownRecord[] = [];
  const toasts: UnknownRecord[] = [];
  let layer: UnknownRecord | undefined;
  let disposed: (() => void) | undefined;

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
  const api = {
    state: { path: { config: root } },
    keymap: {
      registerLayer(value: UnknownRecord) {
        layer = value;
        return () => undefined;
      },
    },
    lifecycle: {
      onDispose(value: () => void) {
        disposed = value;
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

  try {
    await mkdir(join(root, "continuous-learning"), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ ...DEFAULT_CONFIG, futureSetting: 7 }, null, 2)}\n`,
    );

    await tuiModule.tui(
      api as never,
      {
        configPath,
        dataRoot: join(root, "data"),
        skillsRoot: join(root, "skills"),
      },
      {} as never,
    );
    assert.ok(layer);
    assert.equal(typeof disposed, "function");
    const commands = layer.commands as UnknownRecord[];
    assert.deepEqual(
      commands.map((command) => command.slashName),
      ["learning-settings", "learning-pending", "learning-journey"],
    );
    await (commands[0].run as () => Promise<void>)();

    const first = renders.at(-1) as UnknownRecord;
    assert.equal(first.kind, "select");
    const options = first.options as UnknownRecord[];
    assert.equal(options.length, 28);
    for (const option of options) assert.equal(option.description, undefined);
    const memoryContext = options.find(
      (option) =>
        (option.value as UnknownRecord).key === "memoryContextEnabled",
    );
    assert.ok(memoryContext);
    assert.equal(memoryContext.title, "在对话中使用记忆");
    assert.equal(memoryContext.footer, "[开]");
    const resourceFields = options.filter(
      (option) => option.category === "资源限制",
    );
    assert.equal(resourceFields.length, 5);
    for (const option of resourceFields) {
      assert.match(String(option.footer), /^\[[^\[\]]+\]$/u);
    }
    const enabled = options.find(
      (option) => (option.value as UnknownRecord).key === "enabled",
    );
    assert.ok(enabled);
    (first.onSelect as (option: UnknownRecord) => void)(enabled);
    await waitFor(async () => {
      const value = JSON.parse(await readFile(configPath, "utf8")) as {
        enabled: boolean;
      };
      return value.enabled === false;
    });

    const second = renders.at(-1) as UnknownRecord;
    const memoryTurns = (second.options as UnknownRecord[]).find(
      (option) => (option.value as UnknownRecord).key === "memoryEveryTurns",
    );
    assert.ok(memoryTurns);
    (second.onSelect as (option: UnknownRecord) => void)(memoryTurns);
    const prompt = renders.at(-1) as UnknownRecord;
    assert.equal(prompt.kind, "prompt");
    (prompt.onConfirm as (value: string) => void)("0");
    assert.equal(
      (
        JSON.parse(await readFile(configPath, "utf8")) as {
          memoryEveryTurns: number;
        }
      ).memoryEveryTurns,
      10,
    );
    assert.equal(toasts.at(-1)?.variant, "error");
    (prompt.onConfirm as (value: string) => void)("20");
    await waitFor(async () => {
      const value = JSON.parse(await readFile(configPath, "utf8")) as {
        memoryEveryTurns: number;
      };
      return value.memoryEveryTurns === 20;
    });

    const third = renders.at(-1) as UnknownRecord;
    const reset = (third.options as UnknownRecord[]).find(
      (option) => (option.value as UnknownRecord).type === "reset",
    );
    assert.ok(reset);
    (third.onSelect as (option: UnknownRecord) => void)(reset);
    const confirm = renders.at(-1) as UnknownRecord;
    assert.equal(confirm.kind, "confirm");
    (confirm.onConfirm as () => void)();
    await waitFor(async () => {
      const value = JSON.parse(await readFile(configPath, "utf8")) as {
        enabled: boolean;
        memoryEveryTurns: number;
      };
      return (
        value.enabled === true &&
        value.memoryEveryTurns === DEFAULT_CONFIG.memoryEveryTurns
      );
    });
    const raw = JSON.parse(await readFile(configPath, "utf8")) as UnknownRecord;
    assert.equal(raw.futureSetting, 7);

    await new PendingWriteStore(join(root, "data")).stage({
      summary: "remember the project port",
      origin: "background_review",
      projectRoot: root,
      payload: {
        kind: "memory",
        action: "add",
        target: "project",
        content: "Port 3000",
      },
    });
    await (commands[1].run as () => Promise<void>)();
    const pending = renders.at(-1) as UnknownRecord;
    assert.equal(pending.kind, "select");
    assert.match(String(pending.title), /待审批写入（1）/u);

    await new LearningJourneyStore(join(root, "data")).append({
      kind: "memory",
      action: "add",
      label: "Port 3000",
      projectRoot: root,
    });
    await (commands[2].run as () => Promise<void>)();
    const journey = renders.at(-1) as UnknownRecord;
    assert.equal(journey.kind, "select");
    assert.match(String(journey.title), /学习时间线（1）/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
