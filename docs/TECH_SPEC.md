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
│  ├─ reading-mode.ts       # 同步笔记强制以阅读视图打开（软只读）
│  └─ bases.ts              # .base YAML 生成器
├─ sync/
│  ├─ engine.ts             # SyncEngine：调度各 Syncer、并发/进度/错误汇总
│  ├─ store.ts              # SyncStore：data.json 中的同步状态（cursor、映射、hash）
│  ├─ article-syncer.ts
│  ├─ highlight-syncer.ts
│  ├─ chat-syncer.ts
│  ├─ chat-notes.ts         # 聊天面板的实时写回通道（与 ChatSyncer 共用一套记账）
│  ├─ article-refresh.ts    # 划词写回后单篇重建（复用 ArticleSyncer 的写入路径）
│  ├─ render/               # Markdown 模板渲染（article.ts / highlight.ts / chat.ts）
│  └─ anchor.ts             # 高亮正文锚点匹配与注入
├─ annotations/            # 批注：侧边栏、划词创建高亮/评论、偏移反向映射
│  ├─ feature.ts           #   视图/命令/右键菜单注册
│  ├─ controller.ts        #   当前文章的高亮+评论状态（按 reading_id 缓存）
│  ├─ plaintext.ts         #   HTML → 后端口径纯文本（4 种候选口径）
│  ├─ locate.ts            #   Markdown 选区 → 纯文本 code point 偏移
│  ├─ calibrate.ts         #   拿已有高亮反推口径（自动校准）
│  ├─ source.ts            #   正文 HTML 缓存（插件目录 cache/）
│  └─ reveal.ts            #   从侧边栏跳回正文位置
├─ chat/
│  ├─ view.tsx              # ChatView(右边栏 ItemView) + React 挂载
│  ├─ feature.ts            # 视图/命令/菜单注册 + 文章↔会话绑定的落盘 + 每轮写回 Markdown
│  ├─ controller.ts         # ChatController：会话状态机（core 之上、UI 之下）
│  └─ components/           # ChatPanel / MessageList / Composer / SessionPicker
├─ ui/                     # 各 feature 共用的 Obsidian 外壳工具（feature 之间不互相 import）
│  ├─ leaf.ts              #   打开/复用视图 leaf
│  ├─ selection.ts         #   编辑/阅读两种模式下取选区
│  └─ context-menu.ts      #   Puzle 右键菜单注册表：editor-menu + 阅读模式 contextmenu
├─ settings.ts              # PuzleSettingTab + Settings 类型 + DEFAULT_SETTINGS
└─ main.ts                  # 装配：实例化 core（注入 adapters）→ 注册命令/视图/设置/自动同步
```

**依赖规则**（解耦要求的落点）：
1. `core/` 零 Obsidian 依赖，网络/日志经 `ports.ts` 注入 —— 数据层可单独复用（如未来 CLI/其他编辑器插件）。
2. `sync/`、`chat/`、`annotations/` 互不 import，只依赖 `core/` + `vault/` + `ui/`；砍掉任何一个功能不影响其余。
3. `main.ts` 是唯一装配点；功能模块以「注册器」形式暴露：`registerSyncFeature(plugin, deps)` / `registerChatFeature(plugin, deps, {chatNotes, contextMenu})` / `registerAnnotationsFeature(plugin, deps, hooks)` / `registerWriterFeature(plugin, deps, contextMenu)`。跨功能的协作物（`ChatNotes` / `ArticleRefresher` / `PuzleContextMenu`）由 `main.ts` 创建后注入，功能之间仍不互相 import。

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
puzle_id: 1727                  # 聊天面板实时写回时缺省不写，等同步补上
title: 关于阅读层次的讨论
created: 2026-03-18T14:46:40Z   # 同上
synced: 2026-07-16T12:00:00Z
---

%% puzle:begin %%
## 🙋 我

> 阅读的四个层次是什么？

## 🤖 Puzle
（assistant 文本；思考/工具调用默认省略，设置开启后渲染为
> [!note]- 🧠 思考过程
> …折叠 callout）
%% puzle:end %%
```

### 3.5 data.json（settings + sync state 合一）

```ts
interface PluginData {
  settings: {
    baseUrl: string;              // 默认 https://read-web.puzle.com.cn（生产）
    token: string;
    rootFolder: string;           // 默认 "PuzleRead"
    autoSyncMinutes: number;      // 0 = 关闭
    injectAnchors: boolean;       // 正文插高亮锚点，默认 true
    readingMode: boolean;         // 同步笔记以阅读模式打开，默认 true
    keepThinking: boolean;        // 对话保留思考过程，默认 false
    onEditedManaged: 'overwrite' | 'skip';   // 默认 'overwrite'
    plaintextVariant: string;     // 高亮偏移口径，默认 'raw'，可自动校准
  };
  syncState: {
    lastSyncAt: string | null;
    articles: Record<number /*reading_id*/, {
      path: string; fingerprint: string;       // fingerprint = hash(status,title,highlight_count,comment_count,last_comment_at)
      managedHash: string; syncedAt: string;
      chatId?: number | null;                  // 该文章绑定的会话，插件内新建后回填
      resourceType?: 'link' | 'file';          // 「刷新这一篇」该调哪个详情接口；老数据缺失时现探测
    }>;
    highlights: Record<number, { path: string; managedHash: string }>;
    chats: Record<number /*chat_id*/, { path: string; turnCount: number; managedHash: string }>;
    continuationChatId: number | null;         // 历史遗留：已下线的续写专用会话，仍被 ChatSyncer 与会话列表排除
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
**ArticleRefresher**（`sync/article-refresh.ts`）：划词创建高亮 / 发表想法之后立刻重建这一篇。复用 `fetchArticlePayload` + `writeArticleNote` + `HighlightSyncer`（同步与它是同一条写入路径，只是范围收窄到一篇），所以正文锚点、高亮笔记、`managedHash` 记账口径只有一份实现。`shared.remoteHighlightIds` 只装这一篇，删除清理不会误伤别的文章。失败只提示不抛，下次同步兜底。
**ChatSyncer**：items 里 `resource_type === 'chat'`（跳过历史遗留的 `continuationChatId`、`status==='thinking'`、以及此刻正在聊天面板流式输出的会话）→ WS `chat_history` 循环拉全 turns（每页 40）→ 渲染。turnCount 无变化则跳过。

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

- **ChatController**（不含 UI）：`sessions`（来自 items 的 chat 条目，只留 `{chatId, title}` 供顶部下拉用；边翻页边发状态，避免账号条目多时长时间空列表；历史遗留的 `continuationChatId` 被排除）、`active: {chatId, article, messages, streaming}`；方法 `openSession(chatId)`、`openArticleChat(binding, chatId)`、`send(text, selectedText?)`（`article` 存在时带 `context:{type:'reading',params:{reading_id, selected_text?}}`）、`stop()`。
- **文章 ↔ 会话绑定**：一篇文章只有一个会话。chat_id 优先取 `syncState.articles[id].chatId`，其次取笔记 frontmatter；新会话的 `chat_completion_ack` 回来时双写同步状态与 frontmatter，所以「与本文对话」永远是续聊而不是新建。
- 流式：`core/ws/stream.ts` 的 TurnStreamReducer 消费 `turn_start/message/log/turn_end`，按 marker 协议维护 assistant 消息缓冲；`hidden` 清空；`log` 仅在 keepThinking 时暴露为折叠项。
- **视图**：只有 `ChatView` 一个右边栏 ItemView。顶部会话下拉 + 新建 + 「打开对话笔记」（📄，在主区域打开 `Chats/*.md`）；消息列表流式光标、自动滚动、markdown 用 Obsidian `MarkdownRenderer.render`；输入框 Enter 发送 / Shift+Enter 换行 / 停止按钮。历史留档看 Markdown，不再另开列表/主区域视图。
- **写回 Markdown（sync/chat-notes.ts）**：`chat/feature.ts` 订阅 controller 状态派生两件事 ——
  流式中把该会话标成 busy（ChatSyncer 据此跳过，避免用服务端旧历史盖掉本地新内容）；
  `streaming` 由 true 落回 false（即一轮说完，含断线中断）时整段重渲染写进 `Chats/*.md`，不逐 token 写盘。
  写完把 `path / turnCount / managedHash` 记进 `syncState.chats`，与 ChatSyncer 共用一套记账：
  下次增量同步看到回合数一致就跳过，`onEditedManaged='skip'` 时也不会把本地写回误判成用户编辑。
  回合数口径「宁少勿多」（少算最多重写一遍，多算会漏同步），所以本地用户消息在 turn_end 时补上 turn_id 再计数。
- 生命周期：WS 连接由 main 持有的单例 PuzleSocket 提供；view onClose 只解除订阅不断连；插件 unload 断连并阻断重连。

### 4.4 批注（annotations/）

- **展示**：`AnnotationsController` 按 `reading_id` 拉 `/reading/highlights` + `/reading/comments`，
  高亮按 `location_data.start_index` 排序，评论按 `highlight_id` 归位（`null` 与孤儿评论并入文章级）；
  `hidden` 的高亮不展示（与 Web 端一致：hidden 的 AI 标注不参与任何交互）。结果按文章缓存，切回来不重拉。
- **删除**：`deleteHighlight` / `deleteComment` → `DELETE /reading/highlights|comments/{id}`。
  UI 是两步确认（点一下变「删除高亮？」），不弹模态。AI 生成的高亮/评论**不做前端拦截**
  （Web 端也没有按 role 拦，只挡 `hidden`），后端若拒绝就把服务端原话透到 Notice 与面板 error 上。
  写回类操作（发想法 / 删除）共用 `AnnotationsController.mutate`：提交态 → 调接口 → 重新拉取 → 触发文章笔记刷新 → 提示。
- **定位跳转**：`reveal.ts` 把笔记与高亮 content 都归一化成「有效字符序列」后 indexOf 求行号，
  再用 `MarkdownView.setEphemeralState({line})` 滚动 —— 编辑/阅读两种模式都有效；整段匹配不到时逐级缩短前缀重试。
- **划词创建高亮**：`ui/selection.ts` 在编辑模式走 `Editor`、阅读模式走 DOM `Range` 取选区（同步笔记默认阅读模式，后者是主路径）；
  `locate.ts` 把选区映射成后端 code point 偏移（归一化后按「第几次出现」消歧）；
  `content` 取纯文本切片保证与 start/end 自洽；POST `/reading/highlights`。
  写回成功后调 `ArticleRefresher.refresh(reading_id)` 就地重建这篇笔记，`==高亮==` 与高亮笔记当场出现，不必等下次同步；
  发表想法（文章级 / 高亮回复）走 `AnnotationsController.onAnnotationsChanged` 触发同一个刷新。
- **口径校准**：后端偏移基于「渲染后纯文本」，其确切口径文档未定义。`plaintext.ts` 提供 4 种候选，
  `calibrate.ts` 用账号已有高亮（自带 start/end + content 快照）当标准答案打分，命中率最高者写回设置。

### 4.5 右键菜单（ui/context-menu.ts）

Obsidian 只为编辑模式提供 `editor-menu` 事件，而同步笔记默认以阅读模式打开 —— 所以 Puzle 的菜单项统一注册到
`PuzleContextMenu`，由它挂两条路径：编辑模式走官方 `editor-menu`，阅读模式自己监听预览区的 `contextmenu`
（命中 `MarkdownView.contentEl` 且当前是 preview 模式才接管，否则不 `preventDefault`）再 `Menu.showAtMouseEvent`。
菜单弹出时就把选区快照（`SelectionContext`）交给贡献者，点菜单项时 DOM 选区可能已经没了。
贡献者：批注「创建高亮」（有选区且是文章笔记）、聊天「就这段提问 / 与本文对话」。
`reading` 标记留在上下文里，供「只能在编辑器里干的活」自行退出。

### 4.6 认证与设置

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
