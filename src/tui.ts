import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  TuiDialogSelectOption,
  TuiDialogStack,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";

import {
  CONFIG_FIELD_KEYS,
  CONFIG_FIELD_SPECS,
  type LearningConfig,
  type LearningConfigKey,
  type MemoryTarget,
  type SkillOwner,
  defaultDataRoot,
  loadConfig,
  pruneRetiredConfigFields,
  resetConfig,
  updateConfig,
  validateConfigValue,
} from "./config.ts";
import { ExternalMemoryAdapter } from "./external.ts";
import { LearningJourneyStore } from "./journey.ts";
import {
  applyPendingRecord,
  PendingWriteStore,
  type PendingRecord,
} from "./pending.ts";
import { type SkillSummary } from "./skill.ts";
import { LearningStore } from "./store.ts";

type UnknownRecord = Record<string, unknown>;

type FieldView = {
  label: string;
  category: string;
};

const FIELD_VIEWS: Record<LearningConfigKey, FieldView> = {
  enabled: {
    label: "持续学习总开关",
    category: "模式",
  },
  memoryContextEnabled: {
    label: "在对话中使用记忆",
    category: "模式",
  },
  autoReview: {
    label: "后台自动复盘",
    category: "模式",
  },
  sessionSearchMaxSessions: {
    label: "会话索引上限",
    category: "扩展能力",
  },
  backgroundWriteApproval: {
    label: "后台写入先审批",
    category: "安全与界面",
  },
  externalMemoryProvider: {
    label: "外部记忆 Provider",
    category: "外部记忆",
  },
  externalMemoryAutoSync: {
    label: "自动同步外部记忆",
    category: "外部记忆",
  },
  externalMemoryTopK: {
    label: "外部记忆召回数量",
    category: "外部记忆",
  },
  externalMemoryTimeoutMs: {
    label: "外部记忆超时（毫秒）",
    category: "外部记忆",
  },
  memoryEveryTurns: {
    label: "Memory 复盘回合阈值",
    category: "触发条件",
  },
  skillEveryToolCalls: {
    label: "Skill 复盘工具调用阈值",
    category: "触发条件",
  },
  retryCooldownMinutes: {
    label: "失败重试冷却（分钟）",
    category: "触发条件",
  },
  maxConcurrentReviews: {
    label: "最大并发复盘数",
    category: "资源限制",
  },
  maxTranscriptChars: {
    label: "复盘转录最大字符数",
    category: "资源限制",
  },
  memoryCharLimit: {
    label: "全局 Memory 字符上限",
    category: "资源限制",
  },
  projectMemoryCharLimit: {
    label: "单项目 Memory 字符上限",
    category: "资源限制",
  },
  userCharLimit: {
    label: "用户画像文件字符上限",
    category: "资源限制",
  },
  foregroundWriteApproval: {
    label: "前台写入权限确认",
    category: "安全与界面",
  },
  deleteReviewSessions: {
    label: "复盘后删除内部会话",
    category: "安全与界面",
  },
  showNotifications: {
    label: "显示学习通知",
    category: "安全与界面",
  },
};

type PanelAction =
  | { type: "field"; key: LearningConfigKey }
  | { type: "pending" }
  | { type: "journey" }
  | { type: "memory" }
  | { type: "memorySearch" }
  | { type: "skill" }
  | { type: "overview" }
  | { type: "reset" }
  | { type: "close" };

type PanelPaths = {
  dataRoot: string;
  skillsRoot: string;
  projectRoot: string;
  projectRootActive: boolean;
};

function optionPath(
  options: UnknownRecord | undefined,
  key: string,
  fallback: string,
): string {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectRootActiveFromState(
  statePath: TuiPluginApi["state"]["path"],
): boolean {
  return Boolean(
    (statePath.worktree && statePath.worktree !== "/") || statePath.directory,
  );
}

function truncate(text: string, limit = 80): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function scopeLabel(target: MemoryTarget): string {
  if (target === "memory") return "全局记忆";
  if (target === "user") return "用户画像";
  return "项目记忆";
}

function availableMemoryScopes(paths: PanelPaths): MemoryTarget[] {
  const scopes: MemoryTarget[] = ["memory", "user"];
  if (paths.projectRootActive) scopes.push("project");
  return scopes;
}

function displayValue(value: boolean | number | string): string {
  if (typeof value === "boolean") return value ? "开" : "关";
  return typeof value === "number" ? value.toLocaleString("zh-CN") : value;
}

function fieldFooter(value: boolean | number | string): string {
  return `[${displayValue(value)}]`;
}

function panelOptions(
  config: LearningConfig,
): TuiDialogSelectOption<PanelAction>[] {
  const fields = CONFIG_FIELD_KEYS.map((key) => {
    const value = config[key];
    const view = FIELD_VIEWS[key];
    return {
      title: view.label,
      value: { type: "field", key } as const,
      footer: fieldFooter(value),
      category: view.category,
    };
  });
  return [
    ...fields,
    {
      title: "记忆浏览",
      value: { type: "memory" } as const,
      category: "浏览",
    },
    {
      title: "记忆搜索",
      value: { type: "memorySearch" } as const,
      category: "浏览",
    },
    {
      title: "Skill 浏览",
      value: { type: "skill" } as const,
      category: "浏览",
    },
    {
      title: "全局概览",
      value: { type: "overview" } as const,
      category: "浏览",
    },
    {
      title: "待审批写入",
      value: { type: "pending" },
      category: "操作",
    },
    {
      title: "学习时间线",
      value: { type: "journey" },
      category: "操作",
    },
    {
      title: "恢复全部默认值",
      value: { type: "reset" },
      category: "操作",
    },
    {
      title: "关闭设置面板",
      value: { type: "close" },
      category: "操作",
    },
  ];
}

async function saveField(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  key: LearningConfigKey,
  value: boolean | number | string,
): Promise<void> {
  try {
    await updateConfig(configPath, { [key]: value });
    api.ui.toast({
      variant: "success",
      title: "持续学习设置",
      message: `${FIELD_VIEWS[key].label}已设为 ${displayValue(value)}`,
    });
    await showPanel(api, dialog, configPath);
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "配置保存失败",
      message: errorText(error),
      duration: 6_000,
    });
  }
}

function showEnumSelect(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  key: LearningConfigKey,
): void {
  const spec = CONFIG_FIELD_SPECS[key];
  if (spec.kind !== "enum") return;
  dialog.replace(() =>
    api.ui.DialogSelect<string>({
      title: `设置：${FIELD_VIEWS[key].label}`,
      options: spec.values.map((value) => ({ title: value, value })),
      onSelect(option) {
        void saveField(api, dialog, configPath, key, option.value);
      },
    }),
  );
}

function showIntegerPrompt(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  config: LearningConfig,
  key: LearningConfigKey,
): void {
  const spec = CONFIG_FIELD_SPECS[key];
  if (spec.kind !== "integer") return;
  let saving = false;
  dialog.replace(() =>
    api.ui.DialogPrompt({
      title: `设置：${FIELD_VIEWS[key].label}`,
      placeholder: `${spec.minimum}–${spec.maximum}`,
      value: String(config[key]),
      onConfirm(value) {
        if (saving) return;
        try {
          const trimmed = value.trim();
          if (!/^-?\d+$/u.test(trimmed)) throw new Error("请输入十进制整数");
          const parsed = Number(trimmed);
          validateConfigValue(key, parsed);
          saving = true;
          void saveField(api, dialog, configPath, key, parsed).finally(() => {
            saving = false;
          });
        } catch (error) {
          api.ui.toast({
            variant: "error",
            title: "输入无效",
            message: `${errorText(error)}；合法范围 ${spec.minimum}–${spec.maximum}`,
            duration: 6_000,
          });
        }
      },
    }),
  );
}

function showResetConfirm(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
): void {
  let saving = false;
  dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "恢复持续学习默认设置",
      message: `确认恢复全部 ${CONFIG_FIELD_KEYS.length} 个设置吗？学习数据、Skill 和索引不会被删除。`,
      onConfirm() {
        if (saving) return;
        saving = true;
        void resetConfig(configPath)
          .then(async () => {
            api.ui.toast({
              variant: "success",
              title: "持续学习设置",
              message: "全部设置已恢复默认值",
            });
            await showPanel(api, dialog, configPath);
          })
          .catch((error) => {
            api.ui.toast({
              variant: "error",
              title: "恢复默认值失败",
              message: errorText(error),
              duration: 6_000,
            });
          })
          .finally(() => {
            saving = false;
          });
      },
    }),
  );
}

async function showPendingPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
): Promise<void> {
  const pending = new PendingWriteStore(paths.dataRoot);
  const records = await pending.list();
  dialog.setSize("large");
  dialog.replace(() =>
    api.ui.DialogSelect<PendingRecord | "back">({
      title: `待审批写入（${records.length}）`,
      placeholder: "搜索待审批项…",
      options: [
        ...records.map((record) => ({
          title: record.summary,
          value: record,
          footer: `[${record.id}]`,
          category: record.payload.kind === "memory" ? "Memory" : "Skill",
        })),
        { title: "返回设置", value: "back" as const, category: "操作" },
      ],
      onSelect(option) {
        if (option.value === "back") {
          void showPanel(api, dialog, configPath, paths);
          return;
        }
        showPendingActions(api, dialog, configPath, paths, option.value);
      },
    }),
  );
}

function showPendingActions(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  record: PendingRecord,
): void {
  dialog.replace(() =>
    api.ui.DialogSelect<"approve" | "reject" | "back">({
      title: record.summary,
      options: [
        { title: "批准并写入", value: "approve" },
        { title: "拒绝", value: "reject" },
        { title: "返回列表", value: "back" },
      ],
      onSelect(option) {
        if (option.value === "back") {
          void showPendingPanel(api, dialog, configPath, paths);
          return;
        }
        showPendingConfirm(
          api,
          dialog,
          configPath,
          paths,
          record,
          option.value,
        );
      },
    }),
  );
}

function showPendingConfirm(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  record: PendingRecord,
  action: "approve" | "reject",
): void {
  let saving = false;
  const details = JSON.stringify(record.payload, null, 2);
  dialog.replace(() =>
    api.ui.DialogConfirm({
      title: action === "approve" ? "批准后台写入" : "拒绝后台写入",
      message: `${record.summary}\n\n${details.length > 8_000 ? `${details.slice(0, 7_997)}...` : details}`,
      onConfirm() {
        if (saving) return;
        saving = true;
        const pending = new PendingWriteStore(paths.dataRoot);
        const operation =
          action === "approve"
            ? loadConfig(configPath).then((config) =>
                pending.approve(record.id, (item) =>
                  applyPendingRecord(item, {
                    dataRoot: paths.dataRoot,
                    skillsRoot: paths.skillsRoot,
                    config,
                  }),
                ),
              )
            : pending.reject(record.id);
        void operation
          .then(async () => {
            await new LearningJourneyStore(paths.dataRoot)
              .append({
                kind: "pending",
                action: action === "approve" ? "approved" : "rejected",
                label: record.summary,
                projectRoot: record.projectRoot,
                metadata: {
                  pendingID: record.id,
                  payloadKind: record.payload.kind,
                },
              })
              .catch(() => undefined);
            api.ui.toast({
              variant: "success",
              title: "持续学习审批",
              message: action === "approve" ? "已批准并写入" : "已拒绝",
            });
            await showPendingPanel(api, dialog, configPath, paths);
          })
          .catch((error) => {
            api.ui.toast({
              variant: "error",
              title: "审批失败",
              message: errorText(error),
              duration: 7_000,
            });
          })
          .finally(() => {
            saving = false;
          });
      },
    }),
  );
}

async function showJourneyPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
): Promise<void> {
  const journey = new LearningJourneyStore(paths.dataRoot);
  const events = await journey.timeline(500);
  dialog.setSize("large");
  dialog.replace(() =>
    api.ui.DialogSelect<number | "back">({
      title: `学习时间线（${events.length}）`,
      placeholder: "搜索学习记录…",
      options: [
        ...events.map((event, index) => ({
          title: event.label,
          value: index,
          footer: `[${new Date(event.at).toLocaleString("zh-CN")}]`,
          category: `${event.kind} / ${event.action}`,
        })),
        { title: "返回设置", value: "back" as const, category: "操作" },
      ],
      onSelect(option) {
        if (option.value === "back") {
          void showPanel(api, dialog, configPath, paths);
          return;
        }
        const event = events[option.value];
        dialog.replace(() =>
          api.ui.DialogAlert({
            title: event.label,
            message: JSON.stringify(event, null, 2),
            onConfirm: () =>
              void showJourneyPanel(api, dialog, configPath, paths),
          }),
        );
      },
    }),
  );
}

function readonlyStore(
  paths: PanelPaths,
  config: LearningConfig,
): LearningStore {
  return new LearningStore(
    paths.dataRoot,
    paths.skillsRoot,
    config,
    paths.projectRootActive ? paths.projectRoot : undefined,
  );
}

async function showMemoryScopesPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
): Promise<void> {
  try {
    dialog.setSize("large");
    dialog.replace(() =>
      api.ui.DialogSelect<MemoryTarget | "back">({
        title: "记忆浏览",
        options: [
          ...(["memory", "user", "project"] as const).map((target) => ({
            title: scopeLabel(target),
            value: target,
            footer:
              target === "project" && !paths.projectRootActive
                ? "[不可用]"
                : undefined,
            category: "作用域",
          })),
          { title: "返回设置", value: "back" as const, category: "操作" },
        ],
        onSelect(option) {
          if (option.value === "back") {
            void showPanel(api, dialog, configPath, paths);
            return;
          }
          if (option.value === "project" && !paths.projectRootActive) {
            dialog.replace(() =>
              api.ui.DialogAlert({
                title: "项目记忆不可用",
                message: "当前会话无活动项目根，项目记忆作用域不可用。",
                onConfirm: () =>
                  void showMemoryScopesPanel(
                    api,
                    dialog,
                    configPath,
                    paths,
                    config,
                  ),
              }),
            );
            return;
          }
          void showMemoryEntriesPanel(
            api,
            dialog,
            configPath,
            paths,
            config,
            option.value,
          );
        },
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "记忆浏览失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showPanel(api, dialog, configPath, paths);
  }
}

async function showMemoryEntriesPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
  target: MemoryTarget,
): Promise<void> {
  try {
    const store = readonlyStore(paths, config);
    const entries = await store.readMemory(target);
    dialog.setSize("large");
    dialog.replace(() =>
      api.ui.DialogSelect<number | "back">({
        title: `${scopeLabel(target)}（${entries.length}）`,
        options: [
          ...entries.map((entry, index) => ({
            title: truncate(entry),
            value: index,
            footer: `[${index + 1}]`,
            category: scopeLabel(target),
          })),
          { title: "返回设置", value: "back" as const, category: "操作" },
        ],
        onSelect(option) {
          if (option.value === "back") {
            void showMemoryScopesPanel(api, dialog, configPath, paths, config);
            return;
          }
          const entry = entries[option.value];
          dialog.replace(() =>
            api.ui.DialogAlert({
              title: scopeLabel(target),
              message: entry,
              onConfirm: () =>
                void showMemoryEntriesPanel(
                  api,
                  dialog,
                  configPath,
                  paths,
                  config,
                  target,
                ),
            }),
          );
        },
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "记忆读取失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showMemoryScopesPanel(api, dialog, configPath, paths, config);
  }
}

async function showMemorySearchPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
): Promise<void> {
  try {
    dialog.setSize("large");
    dialog.replace(() =>
      api.ui.DialogPrompt({
        title: "记忆搜索",
        placeholder: "输入关键字（跨全部可用作用域，大小写不敏感）…",
        onConfirm(value) {
          const keyword = value.trim();
          if (!keyword) {
            void showMemorySearchPanel(api, dialog, configPath, paths, config);
            return;
          }
          void showMemorySearchResults(
            api,
            dialog,
            configPath,
            paths,
            config,
            keyword,
          );
        },
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "记忆搜索失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showPanel(api, dialog, configPath, paths);
  }
}

async function showMemorySearchResults(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
  keyword: string,
): Promise<void> {
  try {
    const store = readonlyStore(paths, config);
    const scopes = availableMemoryScopes(paths);
    const needle = keyword.toLocaleLowerCase();
    const results = (
      await Promise.all(
        scopes.map(async (target) => {
          const entries = await store.readMemory(target);
          return entries
            .filter((entry) => entry.toLocaleLowerCase().includes(needle))
            .map((entry) => ({ target, entry }));
        }),
      )
    ).flat();
    dialog.setSize("large");
    if (results.length === 0) {
      dialog.replace(() =>
        api.ui.DialogAlert({
          title: "记忆搜索结果",
          message: `关键字「${keyword}」无匹配记忆条目。`,
          onConfirm: () =>
            void showMemorySearchPanel(api, dialog, configPath, paths, config),
        }),
      );
      return;
    }
    dialog.replace(() =>
      api.ui.DialogSelect<number | "back">({
        title: `记忆搜索结果（${results.length}）`,
        placeholder: "搜索结果…",
        options: [
          ...results.map((item, index) => ({
            title: truncate(item.entry),
            value: index,
            footer: `[${scopeLabel(item.target)}]`,
            category: scopeLabel(item.target),
          })),
          { title: "返回设置", value: "back" as const, category: "操作" },
        ],
        onSelect(option) {
          if (option.value === "back") {
            void showPanel(api, dialog, configPath, paths);
            return;
          }
          const item = results[option.value];
          dialog.replace(() =>
            api.ui.DialogAlert({
              title: `${scopeLabel(item.target)} · 记忆搜索结果`,
              message: item.entry,
              onConfirm: () =>
                void showMemorySearchResults(
                  api,
                  dialog,
                  configPath,
                  paths,
                  config,
                  keyword,
                ),
            }),
          );
        },
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "记忆搜索失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showMemorySearchPanel(api, dialog, configPath, paths, config);
  }
}

async function showSkillPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
  filterKeyword?: string,
): Promise<void> {
  try {
    const store = readonlyStore(paths, config);
    let skills = await store.listSkills();
    if (filterKeyword) {
      const needle = filterKeyword.toLocaleLowerCase();
      skills = skills.filter(
        (skill) =>
          skill.name.toLocaleLowerCase().includes(needle) ||
          skill.description.toLocaleLowerCase().includes(needle),
      );
    }
    dialog.setSize("large");
    const filterTitle = filterKeyword
      ? `Skill 浏览（${skills.length}，过滤：${filterKeyword}）`
      : `Skill 浏览（${skills.length}）`;
    dialog.replace(() =>
      api.ui.DialogSelect<string | "filter" | "clear" | "back">({
        title: filterTitle,
        placeholder: "搜索 Skill…",
        options: [
          ...skills.map((skill) => ({
            title: skill.name,
            value: skill.name,
            footer: `[${skill.owner} / 自动管理:${skill.autoManaged ? "是" : "否"}]`,
            category: skill.owner,
          })),
          {
            title: "按关键字过滤…",
            value: "filter" as const,
            category: "操作",
          },
          ...(filterKeyword
            ? [
                {
                  title: "清除过滤",
                  value: "clear" as const,
                  category: "操作",
                },
              ]
            : []),
          { title: "返回设置", value: "back" as const, category: "操作" },
        ],
        onSelect(option) {
          if (option.value === "back") {
            void showPanel(api, dialog, configPath, paths);
            return;
          }
          if (option.value === "filter") {
            dialog.replace(() =>
              api.ui.DialogPrompt({
                title: "按关键字过滤 Skill",
                placeholder: "匹配名称或描述（大小写不敏感）…",
                onConfirm(value) {
                  const keyword = value.trim();
                  void showSkillPanel(
                    api,
                    dialog,
                    configPath,
                    paths,
                    config,
                    keyword || undefined,
                  );
                },
              }),
            );
            return;
          }
          if (option.value === "clear") {
            void showSkillPanel(api, dialog, configPath, paths, config);
            return;
          }
          const summary = skills.find((skill) => skill.name === option.value);
          if (!summary) return;
          void showSkillDetail(
            api,
            dialog,
            configPath,
            paths,
            config,
            summary,
            filterKeyword,
          );
        },
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "Skill 浏览失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showPanel(api, dialog, configPath, paths);
  }
}

async function showSkillDetail(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
  summary: SkillSummary,
  filterKeyword?: string,
): Promise<void> {
  try {
    const store = readonlyStore(paths, config);
    const content = await readFile(summary.path, "utf8");
    const provenance = await store.readProvenance(summary.name);
    const provenanceText = provenance
      ? JSON.stringify(provenance, null, 2)
      : "（无 provenance 记录）";
    dialog.replace(() =>
      api.ui.DialogAlert({
        title: `Skill：${summary.name}`,
        message: [
          "—— SKILL.md ——",
          content,
          "",
          "—— Provenance ——",
          provenanceText,
        ].join("\n"),
        onConfirm: () =>
          void showSkillPanel(
            api,
            dialog,
            configPath,
            paths,
            config,
            filterKeyword,
          ),
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "Skill 详情读取失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showSkillPanel(api, dialog, configPath, paths, config, filterKeyword);
  }
}

async function showOverviewPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  paths: PanelPaths,
  config: LearningConfig,
): Promise<void> {
  try {
    const store = readonlyStore(paths, config);
    const scopes = availableMemoryScopes(paths);
    const [
      memoryEntries,
      userEntries,
      projectEntries,
      skills,
      pending,
      status,
    ] = await Promise.all([
      store.readMemory("memory"),
      store.readMemory("user"),
      paths.projectRootActive
        ? store.readMemory("project")
        : Promise.resolve(undefined),
      store.listSkills(),
      new PendingWriteStore(paths.dataRoot).list(),
      new ExternalMemoryAdapter(config, paths.projectRoot).status(),
    ]);
    const projectLine = paths.projectRootActive
      ? `项目记忆：${projectEntries?.length ?? 0} 条`
      : "项目记忆：不可用（当前会话无活动项目根）";
    const providerName = String(
      status.provider ?? config.externalMemoryProvider,
    );
    const configured = Boolean(status.configured);
    const providerLine =
      providerName === "builtin"
        ? "外部记忆 Provider：builtin（内置）"
        : `外部记忆 Provider：${providerName}（${configured ? "已配置" : "未完全配置"}）`;
    const lines = [
      "—— 记忆计数 ——",
      `全局记忆：${memoryEntries.length} 条`,
      `用户画像：${userEntries.length} 条`,
      projectLine,
      "",
      "—— 学习资产 ——",
      `Skill 数量：${skills.length}`,
      `待审批写入：${pending.length}`,
      "",
      "—— 外部记忆 ——",
      providerLine,
      "",
      "—— 模式状态 ——",
      `持续学习：${config.enabled ? "开" : "关"}`,
      `后台自动复盘：${config.autoReview ? "开" : "关"}`,
      "",
      "—— 存储路径 ——",
      `数据目录：${paths.dataRoot}`,
      `Skill 目录：${paths.skillsRoot}`,
      `配置文件：${configPath}`,
    ];
    dialog.setSize("large");
    dialog.replace(() =>
      api.ui.DialogAlert({
        title: "全局概览",
        message: lines.join("\n"),
        onConfirm: () => void showPanel(api, dialog, configPath, paths),
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "全局概览失败",
      message: errorText(error),
      duration: 7_000,
    });
    await showPanel(api, dialog, configPath, paths);
  }
}

export async function showPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  inputPaths?: PanelPaths,
): Promise<void> {
  try {
    const config = await loadConfig(configPath);
    const paths: PanelPaths = inputPaths ?? {
      dataRoot: defaultDataRoot(),
      skillsRoot: join(api.state.path.config, "skills"),
      projectRoot:
        api.state.path.worktree && api.state.path.worktree !== "/"
          ? api.state.path.worktree
          : api.state.path.directory || process.cwd(),
      projectRootActive: projectRootActiveFromState(api.state.path),
    };
    dialog.setSize("large");
    dialog.replace(() =>
      api.ui.DialogSelect<PanelAction>({
        title: "持续学习设置",
        placeholder: "搜索配置项…",
        options: panelOptions(config),
        onSelect(option) {
          const action = option.value;
          if (action.type === "close") {
            dialog.clear();
            return;
          }
          if (action.type === "reset") {
            showResetConfirm(api, dialog, configPath);
            return;
          }
          if (action.type === "pending") {
            void showPendingPanel(api, dialog, configPath, paths);
            return;
          }
          if (action.type === "journey") {
            void showJourneyPanel(api, dialog, configPath, paths);
            return;
          }
          if (action.type === "memory") {
            void showMemoryScopesPanel(api, dialog, configPath, paths, config);
            return;
          }
          if (action.type === "memorySearch") {
            void showMemorySearchPanel(api, dialog, configPath, paths, config);
            return;
          }
          if (action.type === "skill") {
            void showSkillPanel(api, dialog, configPath, paths, config);
            return;
          }
          if (action.type === "overview") {
            void showOverviewPanel(api, dialog, configPath, paths, config);
            return;
          }
          const spec = CONFIG_FIELD_SPECS[action.key];
          if (spec.kind === "boolean") {
            void saveField(
              api,
              dialog,
              configPath,
              action.key,
              !Boolean(config[action.key]),
            );
            return;
          }
          if (spec.kind === "enum") {
            showEnumSelect(api, dialog, configPath, action.key);
            return;
          }
          showIntegerPrompt(api, dialog, configPath, config, action.key);
        },
      }),
    );
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "无法打开持续学习设置",
      message: errorText(error),
      duration: 7_000,
    });
  }
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = rawOptions as UnknownRecord | undefined;
  const configPath = optionPath(
    options,
    "configPath",
    join(api.state.path.config, "continuous-learning", "config.json"),
  );
  await pruneRetiredConfigFields(configPath);
  const paths: PanelPaths = {
    dataRoot: optionPath(options, "dataRoot", defaultDataRoot()),
    skillsRoot: optionPath(
      options,
      "skillsRoot",
      join(api.state.path.config, "skills"),
    ),
    projectRoot:
      api.state.path.worktree && api.state.path.worktree !== "/"
        ? api.state.path.worktree
        : api.state.path.directory || process.cwd(),
    projectRootActive: projectRootActiveFromState(api.state.path),
  };
  const dispose = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "continuous-learning.settings",
        title: "持续学习设置",
        desc: "查看和修改持续学习插件的全部开关、阈值与限制",
        category: "持续学习",
        slashName: "learning-settings",
        slashAliases: ["learning-config"],
        run: () => showPanel(api, api.ui.dialog, configPath, paths),
      },
      {
        namespace: "palette",
        name: "continuous-learning.pending",
        title: "持续学习待审批写入",
        category: "持续学习",
        slashName: "learning-pending",
        run: () => showPendingPanel(api, api.ui.dialog, configPath, paths),
      },
      {
        namespace: "palette",
        name: "continuous-learning.journey",
        title: "持续学习时间线",
        category: "持续学习",
        slashName: "learning-journey",
        run: () => showJourneyPanel(api, api.ui.dialog, configPath, paths),
      },
    ],
  });
  api.lifecycle.onDispose(dispose);
};

export default {
  id: "continuous-learning-settings",
  tui,
};
