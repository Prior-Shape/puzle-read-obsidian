# Puzle Read Obsidian 插件 — PRD

> 状态：已与需求方对齐（2026-07-16）。技术方案见 `docs/TECH_SPEC.md`。

## 1. 背景

Puzle Read 是 AI 驱动的阅读产品（文章阅读 + AI 摘要 + 高亮标注 + AI 对话），后端为独立服务（REST `/api/v1/*` + WebSocket `/api/v1/agent/events`），现有两个 Web 客户端（`puzle-read` 小程序 WebView 版、`puzle-read-web` 桌面 Web 版，共用同一后端）。

本项目为其官方 **Obsidian 插件**，把用户在产品里的阅读资产（文章、高亮、评论、对话）同步进 Obsidian 知识库，并在 Obsidian 内提供 AI 对话与划词批注能力。

## 2. 产品组成（两部分）

1. **Obsidian 插件**（本仓库主体）：同步引擎 + 聊天侧边栏 + 批注侧边栏 + 设置页。
2. **模板 vault**：`PuzleRead/` 文件夹结构 + `.base` 数据库视图文件 + 使用说明。由插件首次运行时自动生成（scaffold），同一套文件也可打包为模板 vault 单独分发。

## 3. 用户与场景

- 目标用户：Puzle Read 用户，同时用 Obsidian 做长期知识管理。
- 场景 1：在产品里读文章、划高亮、写想法 → 在 Obsidian 里检索、组织、二次创作。
- 场景 2：在 Obsidian 里打开右边栏，继续和产品的 AI 对话。
- 场景 3：在 Obsidian 里读同步来的文章，直接划词建高亮、写想法，回传到产品。

## 4. 功能需求（P0）

### P0-1 文章同步（单向：产品 → Obsidian）

- 同步 `GET /api/v1/reading/items` 中 `resource_type ∈ {link, file}` 的条目（`chat` 类型归对话模块）。
- 每篇文章一个 Markdown 文件，落在 `PuzleRead/Articles/`：
  - frontmatter：`puzle_type: article`、`reading_id`、`puzle_id`、`title`、`url`、`author`、`domain`、`status`、`topics`（列表）、`created`、`synced`、`highlight_count`、`comment_count`、`chat_id`。
  - 正文：文章 `content`（详情接口返回的 Markdown）+ AI 摘要区（key_points / new_knowledge / different_opinions / related_information）。
- 增量同步：记录 sync cursor（上次同步时间 + 已同步 id→文件映射），只拉新增/变化；手动命令触发 + 可配置的自动间隔。
- `articles.base`：按主题 / 状态 / 域名 / 时间筛选的数据库视图。

### P0-2 高亮与评论同步（单向）

- **每条高亮一个独立 Markdown 文件**，落在 `PuzleRead/Highlights/`：
  - frontmatter：`puzle_type: highlight`、`highlight_id`、`reading_id`、`article`（指向文章文件的 wiki 链接）、`category`（key_points / new_knowledge / different_opinions / related_information）、`role`（user/assistant）、`color`、`created`。
  - 正文：引文（blockquote）+ 挂靠在该高亮上的评论列表。
- 文章级评论（`highlight_id` 为空）写入文章文件的「想法」区。
- **正文呈现**：在文章正文中用 `==高亮标记==` 还原高亮句子，后跟角标 wiki 链接 `[[高亮文件|💬]]`（悬停预览评论、点击跳转）。定位方式：用高亮 `content` 文本引用在 Markdown 正文中匹配（`start_index/end_index` 辅助消歧）；**匹配失败不报错，兜底显示在文末**。
- 文章文件末尾嵌入该文章的 Base 高亮视图（`## 高亮` 区）。
- `highlights.base`：全局高亮库视图，按分类 / 文章 / 日期筛选、分组。

### P0-3 对话

- **同步**：远端会话（`resource_type: chat` 的 items + WS `chat_history`）落地为 Markdown，`PuzleRead/Chats/`：
  - frontmatter：`puzle_type: chat`、`chat_id`、`puzle_id`、`title`、`created`、`synced`。
  - 正文按 turn 渲染 user / assistant 消息；思考过程与工具调用默认省略（设置项可选保留为折叠 callout）。
- **右边栏聊天面板**：
  - 走产品 WebSocket（`chat_completion`，纯聊天、不携带笔记上下文）。
  - 流式渲染（text delta / marker 协议）、思考中状态、可停止（`stop_completion`）。
  - 支持新建会话与继续历史会话（会话列表拉取 + `chat_history` 加载）。
  - 在 Obsidian 发起的新对话会持久化在产品侧，随下次同步落地为 Markdown 文件。

### P0-4 批注 · 侧边栏与划词写回

- 右边栏「批注」面板跟随当前文章：列出全部高亮、每条高亮下的想法、以及文章级想法；点条目跳回正文位置。
- 正文划词可创建高亮、写想法（阅读模式与编辑模式都有右键入口），回传到产品；写回成功后就地重建这篇笔记，标记当场可见。
- （AI 续写曾作为 P0-4 实现，2026-08-18 二轮评审后下线：与「同步阅读资产」这条主线无关，且是唯一在非 Puzle 笔记上生效的功能。）

### P0-5 认证与设置

- 设置页：
  - 后端地址（默认产品环境，可切换测试环境）。
  - Token：MVP 手动粘贴 JWT（从 Web 端登录后获取）；HTTP 带 `Authorization: Bearer`，WS 用 `puzle-auth-v1.<token>` 子协议。
  - 同步选项：目标根文件夹（默认 `PuzleRead/`）、自动同步间隔（默认关闭/手动）、是否在正文插入高亮锚点、对话是否保留思考过程。
  - 连接测试按钮（调 `/api/v1/users/profile`）。

## 5. P1（本期不做，架构上预留）

- 高亮 / 评论回传产品（双向同步）。
- 聊天携带当前笔记 / 文章上下文（WS 协议已支持 `context.reading`）。
- 设备授权码登录流（`POST /api/v1/auth/device/code`）替代手动粘贴 token。
- 文章内选中文字直接创建高亮并回传。

## 6. 非目标

- 不做文章正文的双向编辑 / 发布（产品无此 API）。
- 不做本地直连 LLM（数据面完全以产品后端驱动）。
- 不替代产品阅读器。

## 7. 验收标准（P0）

1. 配好 token 后执行「全量同步」，产品内的文章 / 高亮 / 评论 / 会话在 vault 中生成对应 Markdown，`articles.base`、`highlights.base` 视图可正常筛选浏览。
2. 再次同步只更新有变化的条目，用户对非托管区域的修改不丢失。
3. 正文中高亮标记命中率在常规文章上可用，未命中的高亮可在文末视图中找到。
4. 右边栏可新建对话并流式收到回复；重启 Obsidian 后能继续该会话；下次同步后该会话出现在 `Chats/`。
5. 在文章正文划词创建高亮，笔记正文当场出现 `==高亮==` 与对应的高亮笔记，不必等下次同步。
