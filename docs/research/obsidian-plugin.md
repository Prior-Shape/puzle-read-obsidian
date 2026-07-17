# Obsidian 插件开发调研笔记

> 调研日期 2026-07-16；Obsidian 最新 1.13.2。Bases 视图插件 API 自 1.10.0 起提供。

## 1. Obsidian Bases（.base 文件）

- `.base` 是**纯 YAML 文本文件**，基于 markdown frontmatter properties 构建数据库视图。
- 官方文档：语法 https://help.obsidian.md/bases/syntax ；函数 https://obsidian.md/help/bases/functions ；视图 https://obsidian.md/help/bases/views
- 顶层键：`filters`、`formulas`、`properties`、`summaries`、`views`。

```yaml
filters:
  and:
    - file.inFolder("PuzleRead/Articles")
    - 'puzle_type == "article"'
formulas:
  age_days: '(now() - created).days'
properties:
  status:
    displayName: 状态
views:
  - type: table            # table/cards (1.9)、list/map (1.10)
    name: "全部文章"        # 列表第一个为默认视图
    limit: 100
    groupBy: { property: note.topic, direction: DESC }
    filters:
      and: [ 'status != "fail"' ]
    order: [ file.name, note.author, note.created ]
    summaries: { formula.age_days: Average }
```

- filters：递归 `and/or/not`，叶子是表达式字符串（`==`、`!=`、比较、函数调用）；全局与 view 级 filters 以 AND 拼接。
- 属性命名空间：`note.xxx`（frontmatter，可省略 `note.`）、`file.*`（name/path/folder/tags/links/backlinks/ctime/mtime/…）、`formula.*`、`this`（**嵌入时指嵌入它的那个文件**）。
- 常用函数：`file.hasLink(f)`、`file.hasTag(...)`、`file.inFolder(f)`、`link(path, display?)`、`if(...)`、`date(s)`、`now()`、string/list/date 方法链。
- **嵌入**：`![[File.base#ViewName]]` 或 markdown 里的 ```` ```base ```` 代码块（内容同 YAML）。在文章内嵌"该文章的高亮"视图可用 filter `file.hasLink(this.file)`（高亮文件的 frontmatter `article` 链接指向文章）。
- **编程创建**：就是写文本文件。`import { stringifyYaml } from 'obsidian'`，`vault.create(path, stringifyYaml(config))`；更新用 `vault.process`。建议先在 App UI 手工建一个 base，以它生成的 YAML 为模板校准。
- view 条目允许写实现自定义的额外键（列宽、sort 等），合法。
- 自定义 Bases 视图有官方 API（`registerBasesView`，1.10+，https://docs.obsidian.md/plugins/guides/bases-view ）；自定义 formula 函数暂无公开 API。本项目 MVP 不需要自定义视图。

## 2. 插件工程

模板：https://github.com/obsidianmd/obsidian-sample-plugin
结构：`src/main.ts`、`manifest.json`、`versions.json`、`esbuild.config.mjs`、`version-bump.mjs`、`tsconfig.json`、`styles.css`。`npm run dev` = watch；Obsidian 里 Cmd+R 重载。

manifest.json 关键字段：`id, name, version, minAppVersion, description, author, isDesktopOnly`。本项目 `minAppVersion` 建议 `1.10.0`（Bases 稳定 + list 视图）。

esbuild 要点：`format: 'cjs'`、`target: 'es2021'`、`outfile: 'main.js'`、external 必须含 `obsidian, electron, @codemirror/*, @lezer/*, ...builtinModules`。

Plugin 类要点：
- `onload()` 里 `addCommand / addRibbonIcon / addSettingTab / registerView / registerEvent / registerDomEvent / registerInterval / this.register(cleanupFn)`；`register*` 系列在 unload 时自动清理。
- 持久化：`loadData()/saveData(obj)` → `.obsidian/plugins/<id>/data.json`（惯例 settings 与 sync state 存同一对象）。

## 3. 右侧边栏视图（ItemView）

```ts
export const VIEW_TYPE_CHAT = 'puzle-chat-view';
class ChatView extends ItemView {
  getViewType() { return VIEW_TYPE_CHAT; }
  getDisplayText() { return 'Puzle Chat'; }
  getIcon() { return 'message-square'; }
  async onOpen() { /* this.contentEl */ }
  async onClose() { /* 清理 */ }
}
// onload:
this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf));
// 激活:
async activateView() {
  const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
  const leaf = leaves[0] ?? workspace.getRightLeaf(false);
  await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
  workspace.revealLeaf(leaf);
}
```
官方警告：**不要把 view 实例存成插件成员**（factory 可能被多次调用），永远用 `getLeavesOfType()` 找。

React 挂载（官方指南 Use React in your plugin）：`onOpen` 里 `this.root = createRoot(this.contentEl); this.root.render(<App/>)`；`onClose` 必须 `this.root?.unmount()`。社区先例：obsidian-copilot（React 18 + ItemView）。

## 4. 网络

- **REST 用 `requestUrl`**（`import { requestUrl } from 'obsidian'`）：绕过 CORS（普通 fetch 会被 CORS 拦，插件 origin 是 `app://obsidian.md`）。签名：`requestUrl({url, method, headers, body, contentType, throw}) → {status, headers, json, text, arrayBuffer}`。**不支持流式**。
- **WebSocket 直接用原生 `WebSocket`**（Electron renderer 可用，握手不受 CORS 限制），支持子协议参数。注意：
  - unload 清理：`this.register(() => { this.unloading = true; this.ws?.close(); })`，用标志位阻断重连定时器。
  - 指数退避 + 抖动 + 上限重连；监听 `window 'online'` / `visibilitychange` 主动重连（休眠唤醒/移动端切后台会掉线）。
  - 定时器用 `this.registerInterval()` 包。

## 5. Vault 文件操作

```ts
vault.create(path, data) / createFolder(path) / getFileByPath(path) / getAbstractFileByPath(path)
vault.read(f)（写回前用）/ cachedRead(f)（只读展示用）
vault.process(f, (data) => newData)   // 原子读改写，防竞态，优先用
vault.trash(f, useSystemTrash)        // 优先于 delete
app.fileManager.processFrontMatter(f, fm => { fm.key = v; })  // 只动指定键，保留用户其他字段；可能抛 YAMLParseError
app.metadataCache.getFileCache(f)?.frontmatter
normalizePath(path)                   // 所有拼接路径先过它
```
文件名需清洗非法字符：`*"\/<>:|?#^[]`。

## 6. 同步类插件最佳实践（readwise-official / obsidian-omnivore 考察）

- **cursor**：readwise 用单调递增的 export id（`lastSavedStatusID`）；omnivore 用 `syncAt` 时间戳 + `updated after` 查询。每批成功后立即 `saveData` 落盘，中断可续。
- **文件定位**：id 写进 frontmatter + data.json 里维护 id→path 映射；靠 id 定位而非文件名（用户会改名/移动；监听 `vault.on('rename')` 更新映射）。
- **防覆盖用户编辑（readwise 核心机制）**：写文件前对现有内容算 hash 与"上次写入的 hash"比对——一致（用户没改）→ 安全覆盖；不一致（用户改过）→ 只追加或跳过。
- omnivore 单文件模式用注释标记锚定区块，按 id 替换区块内容（区块内用户编辑会被覆盖，弱于 hash 方案）。
- 并发防护：`isSyncing` 布尔；失败队列重试。

## 7. 模板 vault 分发

- 推荐：**插件首次运行时幂等生成**文件夹结构与 .base 文件（scaffold + 显式"初始化/修复工作区"命令，完成标记存 data.json）；readwise/omnivore 均为此模式。
- 可选补充：打包 zip 模板 vault（可含 `.obsidian/` 配置与已启用插件），用户"Open folder as vault"。首次打开会弹社区插件信任确认。
- 插件不能替用户启用其他插件或静默改 `.obsidian` 配置（反模式，商店审核不欢迎）。
- Beta 分发用 BRAT（从 GitHub release 安装）。

## 主要来源

- https://help.obsidian.md/bases/syntax 、https://obsidian.md/help/bases/functions 、https://obsidian.md/help/bases/views
- https://docs.obsidian.md/plugins/guides/bases-view 、https://docs.obsidian.md/Reference/TypeScript+API/BasesView
- https://github.com/obsidianmd/obsidian-sample-plugin
- https://docs.obsidian.md/Plugins/User+interface/Views 、…/Getting+started/Use+React+in+your+plugin 、…/Plugins/Vault
- https://docs.obsidian.md/Reference/TypeScript+API/requestUrl 、…/FileManager/processFrontMatter
- https://github.com/readwiseio/obsidian-readwise 、https://deepwiki.com/omnivore-app/obsidian-omnivore/3.1-synchronization-process
- https://github.com/logancyang/obsidian-copilot
