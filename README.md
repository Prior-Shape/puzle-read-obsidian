# Puzle Read — Obsidian 插件

把你在 [Puzle Read](https://puzle.com.cn) 中的阅读资产同步进 Obsidian 知识库：

- **文章 / 高亮 / 评论同步** — 每篇文章、每条高亮一个 Markdown 文件，附带 `Articles.base`、`Highlights.base` 数据库视图，可按主题、分类、文章、时间筛选浏览；文章正文中用 `==高亮==` 标记还原你的划线。
- **批注侧边栏** — 打开文章即在右边栏列出它的全部高亮、每条高亮下的想法、以及文章级想法；点条目跳到正文对应位置，可直接写想法、也可以「就这段提问」。选中正文执行「创建高亮」即回传到 Puzle。
- **AI 对话** — 右边栏聊天面板直连 Puzle AI，流式回复、可停止；每说完一轮就把整段对话写回 `Chats/*.md`，翻看历史直接读 Markdown。在任意文章上执行「与本文对话」即可就这篇文章提问，一篇文章始终对应同一个会话。

![同步与 Bases 视图截图占位](docs/assets/screenshot-sync.png)
![聊天面板截图占位](docs/assets/screenshot-chat.png)

## 使用要求与网络说明

本插件需要 Puzle Read 账号和网络连接。插件只会连接 Puzle Read 服务，用于验证账号、同步文章/高亮/评论及发送 AI 对话请求；相关内容会按你的操作在 Puzle Read 与当前 Obsidian vault 之间同步。认证 Token 保存在本地 vault 的插件数据目录中，详见下方配置与安全提示。

## 安装

要求 Obsidian ≥ 1.10.0（Bases 视图依赖）。

### 方式一：BRAT（推荐，可自动更新）

1. 在社区插件市场安装并启用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)。
2. 命令面板执行 `BRAT: Add a beta plugin for testing`，填入本仓库地址（`Prior-Shape/puzle-read-obsidian`）。
3. 在 设置 → 第三方插件 中启用 **Puzle Read**。

### 方式二：手动安装

1. 从 [Releases](../../releases) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 vault 的 `.obsidian/plugins/puzle-read/` 目录。
3. 重启 Obsidian，在 设置 → 第三方插件 中启用 **Puzle Read**。

### 可选：模板 vault

如果你想在一个全新的 vault 里体验，可以下载 `puzle-read-template-vault.zip`（Releases 附件，或本地执行 `npm run build:template` 生成于 `dist/`），解压后即得到预置好 `PuzleRead/` 目录结构与 Base 视图的模板。插件首次同步时也会自动生成同样的结构，模板并非必需。

## 配置

打开 设置 → **Puzle Read**：

1. **Base URL** — 后端服务地址，默认为产品环境，一般无需修改。
2. **Token** — 获取方式：
   1. 用浏览器登录 Puzle Read Web 端；
   2. 打开开发者工具（F12）→ Application / 存储 → Local Storage；
   3. 复制 `puzle_auth_token` 的值，粘贴到设置页的 Token 输入框。
3. 点击 **测试连接** — 显示「连接成功：<用户名>」即配置完成。
4. 按提示执行命令 **「Puzle Read: 全量同步」**。首次同步会自动初始化 `PuzleRead/` 工作区（文件夹 + Base 视图 + 使用说明），然后拉取全部文章与高亮。

其他设置项：同步根目录（默认 `PuzleRead`，输入时自动补全 Vault 内已有文件夹）、自动同步间隔（默认关闭）、是否在正文注入高亮锚点、是否以阅读模式打开同步内容（默认开，防手滑改正文）、对话是否保留思考过程、managed 区被本地编辑后的写入策略、高亮定位口径（可自动校准）。

> Token 过期后接口会返回 401，插件会弹出「Token 已失效」提示，重新粘贴新 Token 即可。
>
> 安全提示：Token 以明文保存在 Vault 的 `.obsidian/plugins/puzle-read/data.json` 中。若你把 Vault 同步到云端或提交到 git，请注意不要泄露该文件。

## 使用

### 同步

- 命令：`Puzle Read: 全量同步` / `Puzle Read: 增量同步` / `Puzle Read: 初始化工作区`。
- 增量同步只拉取有变化的条目；全量同步无条件重建全部内容（可用于修复本地与远端不一致）。也可在设置里开启定时自动同步，修改间隔即时生效。
- 每个同步文件中 `%% puzle:begin %%` 与 `%% puzle:end %%` 之间的内容由插件维护，请勿编辑；区外内容完全属于你，同步永不触碰。文件可随意重命名 / 移动，插件按 frontmatter 中的 id 定位。
- 打开 `PuzleRead/Articles.base` / `PuzleRead/Highlights.base` 即可用数据库视图浏览全部文章与高亮。

### 批注

- 打开任意 Puzle 文章，右边栏「Puzle 批注」（ribbon 的 🖍️ 或命令 `Puzle Read: 打开批注面板`）会跟着当前文章刷新。
- 面板里点任意高亮 → 正文滚动到对应位置；「写想法」发表挂在该高亮下的评论；顶部「想法（文章级）」是不挂高亮的整篇评论，也能直接在这里发。
- 「删除」可以删掉高亮（连同它下面的想法）或单条想法，点一下变成「删除高亮？」再点才真删。删完这篇笔记同样立刻重建。
- 选中正文中的一段执行命令 `Puzle Read: 从选中文字创建高亮`，或直接右键选「Puzle: 创建高亮」—— 阅读模式与编辑模式都有这个菜单。高亮回传到 Puzle 后，这篇笔记会**立刻重建**，正文里的 `==高亮==` 与对应的 `Highlights/*.md` 当场出现，不用等下次同步。发表想法同理。

> 高亮的定位靠「后端渲染纯文本的字符偏移」。插件会把正文 HTML 缓存在插件目录下的 `cache/`，并按设置里的「高亮定位口径」换算偏移。首次使用建议在设置里点一次 **自动校准** —— 它会拿你账号里已有的高亮当标准答案反推口径，并告诉你能精确还原的比例。

### AI 对话

- 左侧 ribbon 的 💬 或命令 `Puzle Read: 打开聊天` 打开右边栏聊天面板。
- 顶部下拉可切换 / 新建会话；Enter 发送，Shift+Enter 换行；流式回复过程中可点击停止；📄 在主区域打开当前会话的对话笔记。
- 在文章笔记里执行 `Puzle Read: 与本文对话`（或正文右键菜单，阅读模式同样有），会带上这篇文章的上下文提问；选中一段文字再右键则是「就这段提问」。一篇文章只有一个会话，再次执行是继续上次的对话，不会新建。
- 每说完一轮，当前会话就整段重渲染写回 `PuzleRead/Chats/{标题} (c{chat_id}).md` —— 不必等同步，历史对话在 Vault 里可搜可链接。流式过程中不写盘，同步也会绕开正在输出的那个会话。

---

## 开发

要求 Node.js ≥ 18。

```bash
npm install
npm run dev             # esbuild watch 模式，产出根目录 main.js
npm run build           # tsc 类型检查 + esbuild production 构建
npm test                # vitest run（core/sync 纯逻辑单测）
npm run build:template  # 生成模板 vault 并打包为 dist/puzle-read-template-vault.zip
```

### 在测试 vault 中调试

1. 准备一个测试用 vault（不要用日常 vault）。
2. 把构建产物链接（或拷贝）到 vault 的插件目录：

   ```bash
   # 方式一：软链整个仓库（推荐，dev watch 下改动即时生效）
   ln -s "$(pwd)" "<你的测试vault>/.obsidian/plugins/puzle-read"

   # 方式二：只拷贝三个产物文件
   mkdir -p "<你的测试vault>/.obsidian/plugins/puzle-read"
   cp main.js manifest.json styles.css "<你的测试vault>/.obsidian/plugins/puzle-read/"
   ```

3. 在 Obsidian 设置 → 第三方插件 中启用 "Puzle Read"（首次需关闭安全模式）。
4. 修改代码后保持 `npm run dev` 运行，在 Obsidian 里 **Cmd+R** 重载即可看到最新构建。

### 目录结构

```
src/
├─ core/            # 纯 TS 领域层，禁止 import 'obsidian'（网络等经 ports 注入）
│  ├─ api/          #   PuzleClient REST 封装
│  └─ ws/           #   WebSocket 连接管理 / 流式聚合
├─ adapters/        # Obsidian 平台适配（requestUrl / WebSocket / Notice）
├─ vault/           # VaultGateway / 脚手架 / .base 生成
├─ sync/            # 同步引擎与各 Syncer
│  └─ render/       #   Markdown 模板渲染
├─ chat/            # ChatView(ItemView) + React 组件
│  └─ components/
├─ annotations/     # 批注侧边栏 + 划词创建高亮/评论
├─ ui/              # 各 feature 共用的外壳工具（leaf / 选区 / 右键菜单）
└─ main.ts          # 装配点：注册命令/视图/设置
```

需求见 `docs/PRD.md`，模块边界与关键流程见 `docs/TECH_SPEC.md`。
