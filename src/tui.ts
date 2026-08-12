import { join } from "node:path"

import type {
  TuiDialogSelectOption,
  TuiDialogStack,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"

import {
  CONFIG_FIELD_KEYS,
  CONFIG_FIELD_SPECS,
  loadConfig,
  resetConfig,
  updateConfig,
  validateConfigValue,
  type LearningConfig,
  type LearningConfigKey,
} from "./core.ts"

type UnknownRecord = Record<string, unknown>

type FieldView = {
  label: string
  category: string
}

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
}

type PanelAction =
  | { type: "field"; key: LearningConfigKey }
  | { type: "reset" }
  | { type: "close" }

function optionPath(options: UnknownRecord | undefined, key: string, fallback: string): string {
  const value = options?.[key]
  return typeof value === "string" && value.trim() ? value : fallback
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function displayValue(value: boolean | number): string {
  return typeof value === "boolean" ? (value ? "开" : "关") : value.toLocaleString("zh-CN")
}

function fieldFooter(value: boolean | number): string {
  return `[${displayValue(value)}]`
}

function panelOptions(config: LearningConfig): TuiDialogSelectOption<PanelAction>[] {
  const fields = CONFIG_FIELD_KEYS.map((key) => {
    const value = config[key]
    const view = FIELD_VIEWS[key]
    return {
      title: view.label,
      value: { type: "field", key } as const,
      footer: fieldFooter(value),
      category: view.category,
    }
  })
  return [
    ...fields,
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
  ]
}

async function saveField(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  key: LearningConfigKey,
  value: boolean | number,
): Promise<void> {
  try {
    await updateConfig(configPath, { [key]: value })
    api.ui.toast({
      variant: "success",
      title: "持续学习设置",
      message: `${FIELD_VIEWS[key].label}已设为 ${displayValue(value)}`,
    })
    await showPanel(api, dialog, configPath)
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "配置保存失败",
      message: errorText(error),
      duration: 6_000,
    })
  }
}

function showIntegerPrompt(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
  config: LearningConfig,
  key: LearningConfigKey,
): void {
  const spec = CONFIG_FIELD_SPECS[key]
  if (spec.kind !== "integer") return
  let saving = false
  dialog.replace(() =>
    api.ui.DialogPrompt({
      title: `设置：${FIELD_VIEWS[key].label}`,
      placeholder: `${spec.minimum}–${spec.maximum}`,
      value: String(config[key]),
      onConfirm(value) {
        if (saving) return
        try {
          const trimmed = value.trim()
          if (!/^-?\d+$/u.test(trimmed)) throw new Error("请输入十进制整数")
          const parsed = Number(trimmed)
          validateConfigValue(key, parsed)
          saving = true
          void saveField(api, dialog, configPath, key, parsed).finally(() => {
            saving = false
          })
        } catch (error) {
          api.ui.toast({
            variant: "error",
            title: "输入无效",
            message: `${errorText(error)}；合法范围 ${spec.minimum}–${spec.maximum}`,
            duration: 6_000,
          })
        }
      },
    }),
  )
}

function showResetConfirm(api: TuiPluginApi, dialog: TuiDialogStack, configPath: string): void {
  let saving = false
  dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "恢复持续学习默认设置",
      message: "确认恢复全部 14 个设置吗？全局 Memory、项目 Memory、用户画像、Skill 和复盘记录不会被删除。",
      onConfirm() {
        if (saving) return
        saving = true
        void resetConfig(configPath)
          .then(async () => {
            api.ui.toast({
              variant: "success",
              title: "持续学习设置",
              message: "全部设置已恢复默认值",
            })
            await showPanel(api, dialog, configPath)
          })
          .catch((error) => {
            api.ui.toast({
              variant: "error",
              title: "恢复默认值失败",
              message: errorText(error),
              duration: 6_000,
            })
          })
          .finally(() => {
            saving = false
          })
      },
    }),
  )
}

export async function showPanel(
  api: TuiPluginApi,
  dialog: TuiDialogStack,
  configPath: string,
): Promise<void> {
  try {
    const config = await loadConfig(configPath)
    dialog.setSize("large")
    dialog.replace(() =>
      api.ui.DialogSelect<PanelAction>({
        title: "持续学习设置",
        placeholder: "搜索配置项…",
        options: panelOptions(config),
        onSelect(option) {
          const action = option.value
          if (action.type === "close") {
            dialog.clear()
            return
          }
          if (action.type === "reset") {
            showResetConfirm(api, dialog, configPath)
            return
          }
          const spec = CONFIG_FIELD_SPECS[action.key]
          if (spec.kind === "boolean") {
            void saveField(api, dialog, configPath, action.key, !config[action.key])
            return
          }
          showIntegerPrompt(api, dialog, configPath, config, action.key)
        },
      }),
    )
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "无法打开持续学习设置",
      message: errorText(error),
      duration: 7_000,
    })
  }
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = rawOptions as UnknownRecord | undefined
  const configPath = optionPath(
    options,
    "configPath",
    join(api.state.path.config, "continuous-learning", "config.json"),
  )
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
        run: () => showPanel(api, api.ui.dialog, configPath),
      },
    ],
  })
  api.lifecycle.onDispose(dispose)
}

export default {
  id: "continuous-learning-settings",
  tui,
}
