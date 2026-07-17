# Puzle Read Obsidian 插件 — 技术方案

> 前置阅读：`docs/PRD.md`（需求）、`docs/research/backend-api.md`（后端 API）、`docs/research/obsidian-plugin.md`（Obsidian 机制）。

## 1. 技术栈

| 项 | 选型 | 理由 |
|---|---|---|
| 语言/构建 | TypeScript 5 + esbuild（obsidian-sample-plugin 模板，`format: cjs` → `main.js`） | 官方标准 |
| Obsidian | `minAppVersion: 1.10.0` | Bases 嵌入 + list 视图稳定 |
| REST | `requestUrl`（obsidian API） | 绕 CORS；桌面/移动一致 |
| 流式/对话 | 原生 `WebSocket` + 子协议 `puzle-auth-v1.<jwt>` | requestUrl 不支持流式；WS 握手无 CORS |
| 聊天 UI | React 18（仅 ChatView 内 `createRoot` 挂载） | 流式消息列表状态复杂；社区先例 obsidian-copilot |
| YAML | obsidian 自带 `parseYaml/stringifyYaml` | 生成 .base |
| 单测 | vitest（core/sync 纯逻辑；`obsidian` 模块 mock） | core 不依赖 Obsidian 运行时 |

## 2. 架构与模块边界

```
src/
├─ core/                    # ★纯 TS，禁止 import 'obsidian'（未来可拆独立包）
│  ├─ models.ts             #   领域类型：Reading/Article/Highlight/Comment/ChatSession/Turn/…
│  ├─ ports.ts              #   端口接口：HttpPort / SocketFactory / Logger / Clock
│  ├─ api/client.ts         #   PuzleClient：REST 封装（分页迭代器、错误归一）
│  ├─ ws/manager.ts         #   PuzleSocket：连接/认证/心跳/重连/event_id 去重/请求-响应配对
│  ├─ ws/stream.ts          #   TurnStreamReducer：marker 协议聚合（started/delta/completed/full/hidden）
│  └─ ws/history.ts         #   turns → ChatMessage[] 映射
├─ adapters/
│  └─ obsidian.ts           # HttpPort→requestUrl；SocketFactory→WebSocket；Logger→console/Notice
├─ vault/
│  ├─ gateway.ts            # VaultGateway：幂等目录、managed-region 写入、frontmatter、id→path 映射维护
│  ├─ scaffold.ts           # 工作区脚手架（文件夹 + .base + 说明文件），幂等
│  └─ bases.ts              # .base YAML 生成器
├─ sync/
│  ├─ engine.ts             # SyncEngine：调度各 Syncer、并发/进度/错误汇总
│  ├─ store.ts              # SyncStore：data.json 中的同步状态（cursor、映射、hash）
│  ├─ article-syncer.ts
│  ├─ highlight-syncer.ts
│  ├─ chat-syncer.ts
│  ├─ render/               # Markdown 模板渲染（article.ts / highlight.ts / chat.ts）
│  └─ anchor.ts             # 高亮正文锚点匹配与注入
├─ chat/
│  ├─ view.tsx              # ChatView(ItemView) + React 挂载
│  ├─ controller.ts         # ChatController：会话状态机（core 之上、UI 之下）
│  └─ components/           # MessageList / Composer / SessionPicker …
├─ writer/
│  └─ continue.ts           # AI 续写命令（editor → WS → 流式插入）
├─ settings.ts              # PuzleSettingTab + Settings 类型 + DEFAULT_SETTINGS
└─ main.ts                  # 装配：实例化 core（注入 adapters）→ 注册命令/视图/设置/自动同步
```

**依赖规则**（解耦要求的落点）：
1. `core/` 零 Obsidian 依赖，网络/日志经 `ports.ts` 注入 —— 数据层可单独复用（如未来 CLI/其他编辑器插件）。
2. `sync/`、`chat/`、`writer/` 互不 import，只依赖 `core/` + `vault/`；砍掉任何一个功能不影响其余。
3. `main.ts` 是唯一装配点；功能模块以「注册器」形式暴露：`registerSyncFeature(plugin, deps)` / `registerChatFeature(plugin, deps)` / `registerWriterFeature(plugin, deps)`。

## 3. 数据模型

### 3.1 Vault 布局（模板即此结构，scaffold 生成）

```
PuzleRead/                      # 根目录名可在设置里改
├─ Articles/{title} (r{reading_id}).md
├─ Highlights/{article-title} h{highlight_id}.md
├─ Chats/{title} (c{chat_id}).md
├─ Articles.base
├─ Highlights.base
└─ README.md                    # 模板使用说明
```
文件名规则：`sanitize(title)`（去 `*"\/<>:|?#^[]`，截断 60 字符）+ id 后缀保证唯一；重命名/移动由 `vault.on('rename')` 维护 id→path 映射，同步按 id 定位不按名。

### 3.2 文章文件格式

```markdown
---
puzle_type: article
reading_id: 123
puzle_id: 1727
chat_id: 214
title: 如何阅读一本书
url: https://example.com/...
author: 莫提默
domain: example.com
status: done
topics: [阅读方法, 学习]
created: 2026-03-18T14:46:40Z
synced: 2026-07-16T12:00:00Z
highlight_count: 12
comment_count: 3
---

%% puzle:begin %%
## 摘要
> [!abstract] 核心观点
> - …（summary.key_points 等四类，缺省不渲染）

## 正文
（详情接口 content，经高亮锚点注入：==高亮句== [[…h456|💬]]）

## 想法
- 文章级评论（highlight_id 为空的 comment），按时间排列

## 高亮
```base
filters:
  and:
    - file.inFolder("PuzleRead/Highlights")
    - file.hasLink(this.file)
views:
  - type: table
    name: 本文高亮
    order: [file.name, note.category, note.created]
```
%% puzle:end %%

（managed 区外为用户自由区，同步永不触碰）
```

**managed-region 协议**：`%% puzle:begin %%` … `%% puzle:end %%` 之间由插件全量重写；区外内容原样保留。写入用 `vault.process` 原子替换。另存「上次写入的 managed 区 hash」，若发现被用户改动：按设置 `overwrite（默认）/ skip+Notice` 处理。frontmatter 用 `fileManager.processFrontMatter` 只动本插件的键。

### 3.3 高亮文件格式

```markdown
---
puzle_type: highlight
highlight_id: 456
reading_id: 123
article: "[[如何阅读一本书 (r123)]]"
category: key_points        # key_points/new_knowledge/different_opinions/related_information/underline
role: user                  # user | assistant
color: "rgba(255,212,0,.4)"
created: 2026-03-18T15:02:11Z
---

%% puzle:begin %%
> 阅读的第一层次是基础阅读……（highlight.content）

## 想法
- 这点和主题阅读呼应（挂靠该高亮的 comments，含 role 标identifier）
%% puzle:end %%
```

### 3.4 对话文件格式

```markdown
---
puzle_type: chat
chat_id: 214
puzle_id: 1727
title: 关于阅读层次的讨论
created: 2026-03-18T14:46:40Z
synced: 2026-07-16T12:00:00Z
---

%% puzle:begin %%
## 对话

**🙋 我**（2026-03-18 22:46）
> 阅读的四个层次是什么？

**🤖 Puzle**
（assistant 文本；思考/工具调用默认省略，设置开启后渲染为
> [!note]- 🧠 思考过程
> …折叠 callout）
%% puzle:end %%
```

### 3.5 data.json（settings + sync state 合一）

```ts
interface PluginData {
  settings: {
    baseUrl: string;              // 默认 https://read-web-test.puzle.com.cn
    token: string;
    rootFolder: string;           // 默认 "PuzleRead"
    autoSyncMinutes: number;      // 0 = 关闭
    injectAnchors: boolean;       // 正文插高亮锚点，默认 true
    keepThinking: boolean;        // 对话保留思考过程，默认 false
    onEditedManaged: 'overwrite' | 'skip';   // 默认 'overwrite'
    continueMaxChars: number;     // 续写取上文字符数，默认 4000
  };
  syncState: {
    lastSyncAt: string | null;
    articles: Record<number /*reading_id*/, {
      path: string; fingerprint: string;       // fingerprint = hash(status,title,highlight_count,comment_count,last_comment_at)
      managedHash: string; syncedAt: string;
    }>;
    highlights: Record<number, { path: string; managedHash: string }>;
    chats: Record<number /*chat_id*/, { path: string; turnCount: number; managedHash: string }>;
    continuationChatId: number | null;         // 续写专用会话，ChatSyncer 跳过它
  };
}
```

### 3.6 .base 文件（bases.ts 生成，完整 YAML）

`Articles.base`：filters `file.inFolder("PuzleRead/Articles") AND puzle_type == "article"`；views：
- table「全部文章」：order `[file.name, note.author, note.domain, note.status, note.highlight_count, note.created]`
- table「按主题」：groupBy `note.topics`
- cards「最近阅读」：sort `note.created DESC`，limit 50

`Highlights.base`：filters `file.inFolder("PuzleRead/Highlights") AND puzle_type == "highlight"`；views：
- table「全部高亮」：order `[file.name, note.article, note.category, note.created]`
- table「按分类」：groupBy `note.category`
- table「按文章」：groupBy `note.article`

（实现时先在 Obsidian UI 手工建一个 base 校准字段名，再固化进 `bases.ts`。）

## 4. 关键流程

### 4.1 SyncEngine

```
runSync(mode: 'full' | 'incremental'):
  guard isSyncing
  for syncer of [ArticleSyncer, HighlightSyncer, ChatSyncer]:   # 顺序执行，内部各自分页
    report += await syncer.sync(ctx)
  saveData(); Notice(汇总)
interface Syncer { readonly key: string; sync(ctx: SyncContext): Promise<SyncReport> }
SyncContext = { client, vaultGateway, store, settings, signal }
```

**ArticleSyncer**：分页拉 `/reading/items`（page_size=50），过滤 `resource_type ∈ {link,file}` 且 `status ∈ {done,viewed,interacted}`；对每条算 fingerprint，与 store 比对 → 新增/变化的才拉详情 + summary + highlights + comments，渲染并写入；incremental 模式可在连续 N 页全部命中缓存后提前停止。
**HighlightSyncer**：在 ArticleSyncer 拉详情时顺带完成（同一次循环写高亮文件），独立成模块只为职责清晰——真实执行由 engine 传递共享的批数据，避免重复请求。
**ChatSyncer**：items 里 `resource_type === 'chat'`（跳过 `continuationChatId` 与 `status==='thinking'`）→ WS `chat_history` 循环拉全 turns（每页 40）→ 渲染。turnCount 无变化则跳过。

### 4.2 高亮锚点注入（sync/anchor.ts，纯函数，重点单测）

```
injectAnchors(markdown: string, highlights: {id, content, start_index, linkTarget}[]):
  → { markdown: string, misses: Highlight[] }
```
1. 预处理：跳过 code fence / frontmatter 区；对 markdown 构建「归一化纯文本 → 源码 offset」映射（NFC、折叠空白、剥离 `**_~==[]()` 等行内标记字符时记录映射）。
2. 对每条高亮：归一化 `content` 后在映射文本中查找全部命中；多命中时取与 `start_index` 相对次序最接近的一个（高亮按 start_index 排序后贪心对位）。
3. 命中区间不跨块元素则包裹 `==…==`，段内插入 ` [[Highlights/xxx h456|💬]]`；跨段则每段分别包裹、角标插在末段。从后往前替换保证 offset 稳定。
4. 未命中 → 收入 `misses`，正文不动（文末 Base 视图兜底可见）。

### 4.3 聊天（chat/）

- **ChatController**（不含 UI）：`sessions`（来自 items 的 chat 列表）、`active: {chatId, messages, streaming}`；方法 `openSession(chatId)`（chat_history 全量→history 映射）、`send(text)`（chat_completion；`chat_id=null` 时以 `chat_completion_ack` 回填 id）、`stop()`。
- 流式：`core/ws/stream.ts` 的 TurnStreamReducer 消费 `turn_start/message/log/turn_end`，按 marker 协议维护 assistant 消息缓冲；`hidden` 清空；`log` 仅在 keepThinking 时暴露为折叠项。
- **ChatView**：React 18；顶部会话选择器（下拉+新建）、中部消息列表（流式光标、自动滚动、markdown 渲染用 Obsidian `MarkdownRenderer.render`）、底部输入框（Enter 发送 / Shift+Enter 换行 / 停止按钮）。
- 生命周期：WS 连接由 main 持有的单例 PuzleSocket 提供（聊天与续写共用）；view onClose 只解除订阅不断连；插件 unload 断连并阻断重连。

### 4.4 AI 续写（writer/continue.ts）

```
command 'puzle-continue-writing'（editorCallback）:
  prefix = editor.getRange(0,0 → cursor)，尾部截取 continueMaxChars
  chatId = store.continuationChatId ?? null
  send chat_completion {chat_id: chatId, content: PROMPT(prefix)}
  ack → 若新建则记住 continuationChatId
  只消费 message/text 事件：每个 delta → editor.replaceRange(delta, cursor++)（记录插入起点，completed 时用完整文本校正替换整段插入区）
  turn_end / 用户再次触发命令或点状态栏「停止」→ stop_completion
```
PROMPT 模板：`请直接续写以下文字，不要重复原文，不要解释，直接输出续写内容：\n\n<prefix>`。插入的内容不带任何标记。同一时刻只允许一个续写任务（chat_id 级并发锁与后端一致）。

### 4.5 认证与设置

- 设置页字段见 §3.5 settings；「测试连接」按钮调 `GET /api/v1/users/profile`，成功显示用户名，401 提示重新粘贴 token。
- PuzleClient 对 401/401001 统一抛 `AuthError`，各功能捕获后 Notice「Token 已失效」。
- token 变更 → 重建 PuzleSocket。

## 5. 错误处理与边界

- WS：指数退避（1s→30s+抖动）；`window online`/`visibilitychange` 触发立即重连；unload 清理（`this.register`）。
- REST：429/5xx 退避重试 2 次；分页循环设硬上限（10000 条）防死循环。
- 同步中断（signal/报错）：store 每批落盘，重跑幂等续传。
- 文件冲突：全部写入走 `vault.process`；目标文件被删 → 视为新建；被改名 → rename 事件已更新映射。

## 6. 测试与验收

- vitest 单测（不依赖 Obsidian）：`anchor.ts`（含中英文、重复句、跨段、代码块内不匹配等用例）、`stream.ts`（marker 协议全 5 种 + hidden 场景，用 `puzle-read/ws_stream_sample.json` 回放）、`render/*`（快照）、`bases.ts`（YAML 可解析）。
- 手动验收：连测试环境按 PRD §7 五条验收标准走查。
- dev 流程：`npm run dev` + 测试 vault 软链 + Cmd+R 重载。
