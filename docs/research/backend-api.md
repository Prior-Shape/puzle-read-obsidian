# Puzle Read 后端 API 调研（供插件开发）

> 来源：对 `puzle-read`（旧 Web 客户端）与 `puzle-read-web`（新 Web 客户端）两个仓库的代码调研（2026-07-16）。
> 结论：两者是**同一后端**的两个客户端（`puzle-read-web/lib/ws/manager.ts:2` 注明"移植自 puzle-read"，两仓库的 `websocket-api.md` 字节完全相同）。插件直接复用该后端。

## 0. 环境与认证（最重要）

- **后端为独立服务**，REST 前缀 `/api/v1/*`，WebSocket 端点 `/api/v1/agent/events`。
- Base URL（测试环境，插件需做成设置项）：
  - `https://read-web-test.puzle.com.cn`（puzle-read-web 使用）
  - `https://read-dev.prior-shape.com/puzle-read`（puzle-read 使用，注意含路径前缀）
- **HTTP 认证**：`Authorization: Bearer <JWT>`。不使用 cookie。
  - Web 端 token 存 `localStorage`（key：`puzle_auth_token`，puzle-read 用 `token`）。
  - 401 或响应体 `code ∈ {401, 401001}` = token 失效；`code=404001` = 用户不存在。
- **WebSocket 认证**：子协议 `Sec-WebSocket-Protocol: puzle-auth-v1.<jwt>`，即 `new WebSocket(url, ['puzle-auth-v1.' + token])`。兼容方式：连上后首条消息发 `{"token": "<jwt>"}`。认证失败服务端以 code `4001` 关闭。
- **响应包装**（puzle-read-web 的 `lib/request.ts`）：`{ code, data, msg }`，`code === 0` 为成功。
- 登录 API（P1 设备授权码流用）：
  - `POST /api/v1/auth/sms/send` `{phone, country_code, captcha_token?}`
  - `POST /api/v1/auth/sso/phone` `{phone, code, country_code}` → `{access_token, refresh_token}`
  - `POST /api/v1/auth/device/code` → `{code, expires_in}`（设备授权码，给其他设备/扩展授权）
- 用户：`GET /api/v1/users/profile` → `{id, username, avatar_url, has_mobile, is_tourist, logged, onboarded}`（可作为"连接测试"端点）。

## 1. 核心实体与主键关系

`puzle_id`（全局实体 id）↔ `reading id`（文章/阅读条目）↔ `chat_id`（该文章关联的对话）↔ `task_id`（AI 任务）。
高亮/评论通过 `reading_id`（+ 可选 `highlight_id`）挂靠。
高亮定位统一是「渲染后正文纯文本的 Unicode code-point 字符偏移」。

## 2. 文章（reading）

`resource_type ∈ {link, file, chat}`（`chat` 类条目即"会话"，出现在同一列表里）。

### 列表项 `LinkReadingItem` / `ReadingItem`
```
id, task_id, resource_type, resource_id, chat_id?, created_time,
last_comment_at?, highlight_count, title?, url?, thumbnail?,
status?, puzle_id, domain, domain_cn?, author?,
topics?[{id,title}], comment_count?, key_point_count?, supplemental_count?
```
状态 `EArticleStatus`: `fetching / parsing / ai_reading / viewed / interacted / done / fail`（会话生成中为 `thinking`）。

### 详情
- `LinkReadingDetail` = 列表项 + `content`（正文 Markdown）、`publish_at?`、`intro?`、`reading_time_minutes?`、`ai_insights?[{title?,content}]`、`sections?[{heading?,content}]`、`chat_history?`、`chat_id?`
- `ReadingFileDetailModel`（文件）：+ `file_name, human_media_type, content, download_link`

### API
| 用途 | Method | Path |
|---|---|---|
| 列表（分页） | GET | `/api/v1/reading/items?page=&page_size=&search=&topics=` → `{items,total,page,page_size}` |
| 链接详情（含正文） | GET | `/api/v1/reading/link/{readingId}` |
| 文件详情（含正文） | GET | `/api/v1/reading/file/{readingId}` |
| AI 摘要 | GET | `/api/v1/reading/link/{readingId}/summary` → `{key_points?, new_knowledge?, different_opinions?, related_information?}` |
| 批量状态 | GET | `/api/v1/reading/batch?ids=1,2,3` |
| 压缩分段（偏移对齐用） | GET | `/api/v1/reading/{readingId}/segments` → `CompressedSegmentModel[]` |
| 新建链接 | POST | `/api/v1/reading/link` `{url, topics?}` |
| 删除 | DELETE | `/api/v1/reading/{readingId}` |
| 主题列表 | GET | `/api/v1/topics` → `TopicItem {id,parent_id,title,note_count,reading_count,...}` |

`CompressedSegmentModel`：`{content(该块 markdown), ref_spans:[start,end][], ref_contents:string[], plain_start, plain_end}` —— 正文分段与纯文本偏移的映射，可用于高亮偏移对齐。

## 3. 高亮与评论

### 高亮 `ReadingHighlightItem`
```
id: number
highlight_type: 'text' | 'position' | 'comment'
role: 'user' | 'assistant'          // 用户划的 / AI 划的
category: 'key_points' | 'related_information' | 'different_opinions' | 'new_knowledge'（另见 'underline'）
content?: string                     // 选中原文的文本快照（text-quote，锚点匹配的依据）
color?: string                       // 常为 rgba 字符串
hidden?: boolean                     // true = 不渲染样式但保留定位
created_at: string
location_data: {
  start_index, end_index,            // 渲染后正文纯文本的字符偏移（核心定位，Unicode code point 计数）
  start_tag, start_tag_index, end_tag, end_tag_index,  // 实际创建时传空，勿依赖
  match_index?, comment_ids?
}
```

### 评论 `CommentItem`
```
id, content, role?('user'|'assistant'), created_at, is_liked,
highlight_id?: number | null        // null = 文章级评论；非空 = 挂在某条高亮上
```

### API
| 用途 | Method | Path |
|---|---|---|
| 高亮列表 | GET | `/api/v1/reading/highlights?reading_id=&page=&page_size=` → `{items,total,page,pageSize}` |
| 高亮批量 | GET | `/api/v1/reading/highlights/batch?ids=` |
| 创建高亮（P1 回传用） | POST | `/api/v1/reading/highlights` `{reading_id, highlight_type?, content?, color?, location_data}` |
| 删除高亮 | DELETE | `/api/v1/reading/highlights/{id}` |
| 评论列表 | GET | `/api/v1/reading/comments?reading_id=&highlight_id=&page=&page_size=` |
| 创建评论（P1） | POST | `/api/v1/reading/comments` `{reading_id, highlight_id?, content}` |
| 删除评论 | DELETE | `/api/v1/reading/comments/{id}` |

## 4. 对话（WebSocket 为主通道）

完整规范见 `puzle-read-web/websocket-api.md`（与 `puzle-read/websocket-api.md` 相同）；真实抓包样本：`puzle-read/ws_stream_sample.json`（227KB，一次完整 chat turn 的逐 token 流）。

### 4.1 连接
- 端点：`wss://<host>/api/v1/agent/events`；认证见 §0。
- 心跳：客户端每 **25s** 发文本 `ping`，服务端回 `pong`（收到直接忽略）。
- 重连：指数退避 base 1000ms、max 30000ms；close code `1000` / `4001` 不重连。
- 按 `event_id` 去重（Web 端缓存最近 200 个）。

### 4.2 帧格式
客户端 → 服务端：纯 JSON `{ "type": "<request_type>", ...payload }`。
服务端 → 客户端：`UserFrontEvent` 包装：
```json
{ "event_id": "evt_xxx", "category": "system|chat|task|suggestion|agent",
  "timestamp": "...", "user_id": 1, "event": { "type": "...", ... } }
```
兼容性：需容忍两种形态——`{category, event:{type,...}}` 或整包拍平 `{type,...}`（按 system 处理）。

### 4.3 客户端请求类型
| type | 字段 | 响应（category=system） |
|---|---|---|
| `chat_completion` | `chat_id?: int\|null`（null=新建会话）、`content: string \| ChatContentInput[]`、`context?`、`client_request_id?` | `chat_completion_ack {chat_id, puzle_id}` |
| `chat_history` | `chat_id, offset?=0, limit?=20` | `chat_history_response` |
| `stop_completion` | `chat_id` | `stop_completion_ack` |
| `agent_task_history` | `task_id` | `agent_task_history_response` |

`context`：`{type:'reading', params:{reading_id?, reading_ids?, topic_ids?, selected_text?}}`（文章上下文对话）/ `{type:'onboarding'}` / 不传 = 通用对话。
`ChatContentInput` 多模态：`{type:'text',text}` / `{type:'image'|'file'|'audio', file_key, filename?}`（file_key 需先走上传接口）。
并发限制：同一 `chat_id` 同时只允许一个活跃 completion（Redis 锁 TTL 300s）。

### 4.4 流式响应（category=chat）
一次回复的事件序列：
```
system: chat_completion_ack {chat_id, puzle_id}
chat:   turn_start        {turn_id}
chat:   message           {detail: TextLog}      ← 多次，流式正文
chat:   log               {log: AgentLogContent} ← 可选：thinking/tool_call/tool_result/observation/error
chat:   task_output       {task_id, outputs:[{resource_type,resource_id}]}  ← 可选
chat:   title_generated   {title}                ← 新会话自动起标题
chat:   turn_end          {status:'ok'|'error'|'cancelled', error?, meta?}
```
公共字段：`type, message, chat_id, puzle_id, turn_id`。

**流式 marker 协议**（适用于 `text` / `thinking` / `observation`）：
| marker | 含义 | 处理 |
|---|---|---|
| `started` | 开始，`delta`=首片段 | 追加 delta |
| `delta` | 增量 | 追加 delta |
| `completed` | 结束，主字段为完整文本 | 用主字段**替换**缓冲 |
| `full` | 一次性完整 | 替换 |
| `hidden` | 隐藏此前流出的中间文字 | **清空缓冲**（工具调用前的过渡语） |

`message.detail`：assistant 为 `TextLog {type:'text', text?, delta?, marker?}`；user（历史回放）为 `WsChatMessageContent[]`。
`log.log` 的 `AgentLogContent` 子类型：`text` / `thinking {reasoning, conclusion?}` / `observation {environment, finding}` / `tool_call {tool_name, tool_args}` / `tool_result {tool_name, success, result?, display?}` / `error {error_message, recoverable}`。

### 4.5 历史消息
请求 `{type:'chat_history', chat_id, offset, limit}` → `chat_history_response`：
```
{ chat_id, puzle_id, title, total, has_more, turns: [{ turn_id, events: [...] }] }
```
每个 turn 的 events 含 `message`（role=user/assistant）、`log`、`task_output`；历史为非流式（`marker='full'` 或完整文本）。拉全量：按 `has_more` 循环（Web 端每页 40）。
Web 端把 turn 拍平为消息对的参考实现：`puzle-read-web/lib/ws/chat-history-mapper.ts`。

### 4.6 会话的 REST 面
- 会话列表 = `GET /api/v1/reading/items` 里 `resource_type === 'chat'` 的条目（`id` 即列表 id，`chat_id` 字段为 WS 用的会话 id，`title`、`status`('thinking'=生成中)）。
- 删除会话：`DELETE /api/v1/chat/{chat_id}`。
- SSE 备用通道（puzle-read 在用，插件可不用）：`POST /api/v1/chat/complete`、`GET /api/v1/chat/{chat_id}/resume`、`GET /api/v1/chat/{chat_id}`（取历史）。

## 5. 产品侧没有的能力（插件勿假设存在）

- 无写作/文档编辑/发布 API（用户产出仅：高亮、评论、对话消息）。
- 无导出 / webhook / 公开 API / RSS。
- 无独立的"历史消息 REST 接口"（历史只能走 WS `chat_history`；SSE 的 `GET /api/v1/chat/{chat_id}` 除外）。

## 6. 参考实现文件索引

| 主题 | 文件 |
|---|---|
| WS 协议规范 | `puzle-read-web/websocket-api.md` |
| WS 管理器（认证/心跳/重连/去重/分发） | `puzle-read-web/lib/ws/manager.ts` |
| 历史 turn → 消息映射、流式日志合并 | `puzle-read-web/lib/ws/chat-history-mapper.ts` |
| 流式聚合编排 | `puzle-read-web/provider/chat-provider.tsx` |
| HTTP 层（Bearer、401） | `puzle-read-web/lib/request.ts`、`lib/auth.ts` |
| 文章/高亮/评论 API | `puzle-read-web/lib/api/reading.ts` |
| 数据模型 | `puzle-read-web/types/index.ts`、`types/chat.ts`、`types/ws.ts` |
| 高亮偏移的前端定位实现 | `puzle-read/features/article-detail/hooks/use-highlight.ts` |
| 真实 WS 抓包样本 | `puzle-read/ws_stream_sample.json` |
