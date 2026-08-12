# OpenCode Continuous Learning

这是一个独立的 OpenCode 持续学习插件。它只依赖 OpenCode 的公开插件 API，不导入、复制或运行任何其他 Agent 项目的源码。

插件提供两种学习入口。输入 `/learn 主题` 时，当前 OpenCode Agent 会正常调查资料，然后把经过验证的做法写成标准 `SKILL.md`。平常会话结束并进入空闲状态后，插件按计数阈值启动一个隔离的子会话，只复盘已经发生的对话，并把稳定事实写入长期记忆、把可复用流程写成 Skill。复盘提示不会追加到原会话。

学习结果按作用域分层保存：用户画像在全局 `USER.md`，跨项目环境事实在全局 `MEMORY.md`，项目事实在 `projects/<项目名>-<路径哈希>/MEMORY.md`，可复用流程在 OpenCode 能直接识别的全局 `~/.config/opencode/skills/<name>/SKILL.md`。每个会话只注入当前项目的项目记忆，避免多个项目互相污染。自动生成的 Skill 会有独立的所有权记录；后台只能继续修改自动生成的 Skill，不能改用户手写或通过 `/learn` 主动创建的 Skill。

新写入的 Skill 可以在本插件的新会话快照中通过 `learning_skill view` 立即按需读取。OpenCode 1.18.15 自带的原生 Skill 索引是在进程启动时扫描的，因此要让原生 `skill` 工具也显示刚生成的 Skill，需要重启 OpenCode。

## 安装

先取得源码：

```bash
git clone https://github.com/AscorbicAcid-8848/opencode-continuous-learning.git
cd opencode-continuous-learning
```

在 Windows PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装脚本会把服务端插件、原生 TUI 设置面板、`/learn`、`/learn-review` 命令和[用户手册](docs/用户手册.md)复制到 OpenCode 的全局配置目录。它通过 OpenCode 自带的插件安装命令把面板安全加入 `tui.json`，不会移除已有 TUI 插件；升级时会备份并清理旧版 `/learning-mode` 命令。已有同名文件会先备份，现有 `config.json` 不会被覆盖。设置面板要求 OpenCode 1.18.15 或更高版本。安装后需要完全退出并重新启动 OpenCode。

在 Linux 或 macOS 中运行：

```bash
bash ./scripts/install.sh
```

## 使用

```text
/learning-settings
/learn 如何在这个项目中可靠地执行数据库迁移
/learn-review
```

`/learning-settings` 是 OpenCode 原生 TUI 命令，不会向模型发送消息。也可以打开命令面板，搜索“持续学习设置”。面板可修改全部 14 个配置项、校验数值范围并恢复默认值；保存后当前 OpenCode 进程会自动重载配置，无需重启。“在对话中使用记忆”可以单独关闭历史记忆注入，同时保留学习和落盘。

插件还注册四个模型工具：`learning_memory` 通过 `user`、`memory`、`project` 三个目标管理分层事实，`learning_skill` 管理程序性知识，`learning_status` 查看配置、当前项目分区和复盘进度，`learning_mode` 控制总开关。它们通常由 Agent 自动调用，不需要用户手写工具参数。

自动复盘默认在累计 10 个用户回合或 15 次已完成/失败的工具调用后触发。配置文件位于 `~/.config/opencode/continuous-learning/config.json`。`enabled` 是总开关；关闭后停止知识注入、自动复盘和学习读写，但保留设置、状态与重新开启入口。`autoReview` 只控制后台复盘，不影响显式 `/learn`。

完整操作和配置说明见[用户手册](docs/用户手册.md)，内部实现见[实现原理](docs/实现原理.md)。

## 项目结构

```text
src/        插件核心、服务端入口和 TUI 设置面板
commands/   /learn 与 /learn-review 命令模板
config/     新安装使用的默认配置
install/    部署后的 OpenCode 加载入口与本地插件清单
scripts/    Linux、macOS 和 Windows 安装脚本
tests/      核心、插件编排和 TUI 测试
docs/       用户手册与实现原理
```

## 开发验证

```powershell
npm test
npm run typecheck
```

测试覆盖原子持久化、并发写入、重复项、内容安全扫描、复盘阈值，以及“后台不能修改用户所有 Skill”的边界。
