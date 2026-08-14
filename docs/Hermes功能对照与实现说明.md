# Hermes Agent 功能对照与 OpenCode 适配说明

本文记录 0.5.0 新能力参照了 Hermes Agent 的哪些公开实现，以及为什么没有逐文件照搬。参考基线是 2026-08-13 获取的 NousResearch/hermes-agent `main` 分支。Hermes 是 Python Agent 运行时，OpenCode 插件是 TypeScript/Bun 模块，两者的会话生命周期、权限询问和界面 API 不同，所以可复用的是行为契约、安全规则和数据形状，而不是语言层代码。

## 历史会话全文检索

Hermes 的 `tools/session_search_tool.py` 依赖 `~/.hermes/state.db` 的消息表与 FTS5，公开四种调用形状：query 发现、session id 读取、围绕 message id 滚动、无参数浏览。其官方会话文档也说明发现结果包含会话 bookend、命中窗口和前后消息计数。

本插件在 `src/advanced.ts` 的 `SessionSearchStore` 保留相同形状。区别是 OpenCode 的数据表不是插件公开契约，所以插件通过 `client.session.list/messages/get` 读取数据，再维护自己的 `session-search.sqlite`。SQLite 使用 WAL、外部内容 FTS5 表和同步触发器；中文或 FTS5 语法失败时回退到普通子串检索。OpenCode 1.18 的 `session.list` 受当前项目实例限制，因此首次补建只能看到当前项目；跨项目结果来自不同项目实例后续共同写入全局索引。

参考：

- [Hermes session_search 源码](https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py)
- [Hermes Sessions 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)

## Learning Journey 与 Memory Graph

Hermes 已落地的 Journey 并不是“typed memory + vector + graph traversal”那套提案数据库。其 `agent/learning_graph.py` 把 learned Skill 和 Memory 卡片组成节点，以 Skill 声明关系及 Memory–Skill 词法重叠建边；`agent/learning_graph_render.py` 再按时间渲染学习轨迹。另一方面，typed node、六种关系和混合检索仍记录在 Hermes issue #346 的分阶段提案里。

本插件按已经落地的 Journey 行为实现：`learning-journey.json` 保存最多 5,000 个事件，当前 Memory 与 Skill 形成节点，中英文词元重叠生成 `related_to`，时间相邻生成 `learned_after`。`/learning-journey` 提供原生 TUI 时间线，`learning_journey(action="graph")` 返回图数据。当前实现没有声称具备向量嵌入、重要性衰减或图遍历召回。

参考：

- [Hermes learning_graph.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/learning_graph.py)
- [Hermes learning_graph_render.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/learning_graph_render.py)
- [Hermes Structured Memory 提案 #346](https://github.com/NousResearch/hermes-agent/issues/346)

## 后台写入审批队列

Hermes 的 `tools/write_approval.py` 将后台 Memory/Skill 写入保存为 `<HERMES_HOME>/pending/.../<id>.json`，因为后台线程不能阻塞等待交互确认；批准时重放原始参数，拒绝时丢弃 pending。其 CLI 层提供 pending、approve、reject 和 Skill diff。

本插件的 `PendingWriteStore` 同样按记录独立落盘，但统一存入一个队列，并增加 `history/*.approved.json` 与 `history/*.rejected.json` 审计。后台工具在 gate 开启时只 stage，不触碰真实 Memory/Skill。批准使用记录中的项目根重新建立 `LearningStore`，重新执行当前总开关和安全校验；应用失败会把 `.processing` 恢复为 pending。用户可通过 `/learning-pending` TUI 查看完整参数并处理，也可调用 `learning_pending` 工具。

参考：

- [Hermes write_approval.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/write_approval.py)
- [Hermes write approval commands](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/write_approval_commands.py)

## Mem0 与 Honcho Provider

Hermes 以 `MemoryProvider` 抽象管理外部后端，生命周期包括初始化、system prompt block、prefetch、turn sync、工具和 shutdown，并限制同时只启用一个外部 Provider。Mem0 插件支持 Platform 与 OSS，自托管通过 host 切换；Honcho 插件以 peer/session/message 和 dialectic/semantic search 为核心。

OpenCode 插件没有独立 provider manager 进程，因此使用一个枚举确保同一时间只选 `builtin`、`mem0`、`honcho` 之一。当前用户文本在 `chat.message` 捕获，system transform 进行限时召回，完成回合在 `session.idle` 同步；成功同步的消息 ID 按 Provider 持久化到会话 SQLite，避免重启后重复发送同一回合。Mem0 Platform 使用 V3 `/memories/search/` 与 `/memories/add/`；设置 `MEM0_HOST` 后切到 OSS `/search` 与 `/memories`。Honcho 使用官方 `@honcho-ai/sdk` 2.2.0。所有密钥只读环境变量。

参考：

- [Hermes MemoryProvider 抽象](https://github.com/NousResearch/hermes-agent/blob/main/agent/memory_provider.py)
- [Hermes Mem0 Provider](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/mem0/__init__.py)
- [Hermes Honcho Provider](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/honcho/__init__.py)
- [Mem0 V3 Add API](https://docs.mem0.ai/api-reference/memory/add-memories)
- [Mem0 V3 Search API](https://docs.mem0.ai/api-reference/memory/search-memories)
- [Honcho TypeScript SDK](https://github.com/plastic-labs/honcho#typescript)

## Skill 删除

Hermes 的前台 `skill_manage(action="delete")` 可以硬删除，但后台 curator 的删除走可恢复 archive，并要求 consolidation 场景声明 `absorbed_into`；pinned、外部来源和不可信后台删除还会被拒绝。Journey 用户删除 Skill 也采用归档。

本插件选择更保守的统一语义：无论前台还是后台都移动到 `.continuous-learning-archive`。后台只允许删除 provenance hash 仍可信、owner 为 agent、autoManaged 为 true 的 Skill，并必须提供已存在的 `absorbed_into` 目标。归档目录保留 metadata 与原内容，避免误判造成不可恢复损失。

参考：

- [Hermes skill_manager_tool.py](https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py)
- [Hermes learning_mutations.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/learning_mutations.py)

## 仍然存在的边界

当前版本没有实现 Hermes 全部会话管理（恢复、命名、导出、保留策略），也没有实现其完整 Honcho profile/reasoning/conclusion 工具组、Mem0 memory CRUD 工具组或 skills hub。外部 Provider 目前聚焦自动同步和 search recall。Journey Graph 是可解释的本地关系视图，不含 embedding、RRF、重要性衰减、自动矛盾检测或图 BFS。后台审批没有生成大 Skill 的 unified diff，审阅时展示的是完整 pending JSON；后续可以单独增加 diff 视图。
