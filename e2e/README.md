# E2E：在真实 Obsidian 中验证插件

单测覆盖不了「插件装进 Obsidian 后是否真的能跑」，尤其是后端契约。
这套 E2E 用 CDP 直接驱动真实 Obsidian，可对接本地 mock 后端或真实后端。

## 前置

1. 关闭 Obsidian，用调试端口重新启动：

   ```
   open -a Obsidian --args --remote-debugging-port=9222
   ```

2. 准备沙箱 vault（**不要用自己的 vault**，插件会写文件）：

   ```
   SANDBOX=/tmp/puzle-e2e-vault
   mkdir -p "$SANDBOX/.obsidian/plugins/puzle-read"
   npm run build
   cp main.js manifest.json styles.css "$SANDBOX/.obsidian/plugins/puzle-read/"
   echo '["puzle-read"]' > "$SANDBOX/.obsidian/community-plugins.json"
   ```

3. 在 Obsidian 中打开该 vault（或在已连接的窗口里执行
   `require('electron').ipcRenderer.sendSync('vault-open', '/tmp/puzle-e2e-vault', false)`）。

## 跑 mock 后端用例

```
node e2e/mock-server.mjs &     # 本地 REST + WebSocket，按协议还原
node e2e/run.mjs               # 12 个用例；可传子串过滤，如 node e2e/run.mjs 续写
```

mock 后端的 `/__control` 可注入异常场景（断线、空页、慢速流），
用来验证断线复位、分页死循环保护等修复。

## 对接真实后端（全链路）

`e2e/run-live.mjs` 跑真实后端，覆盖 mock 测不到的契约与端到端行为：
只读（REST 分页 / WS 鉴权与历史 / 会话列表 / 历史渲染）+ 写入
（发消息流式、多轮追问、中途停止、AI 续写、编辑中止）+ 同步 + 设置鉴权。

```
# 先把沙箱 vault 的 data.json 换成真实 baseUrl / token
node e2e/run-live.mjs            # 全部
node e2e/run-live.mjs 只读       # 只跑不产生数据的用例
```

⚠️ **写路径会在账号里产生真实会话记录**，只在明确授权时运行；
跑完记得去 Puzle 里删掉测试会话。

限流：全量同步会对每篇文章发 4 个请求，账号文章多时用例会临时给
`client.iterateAllReadingItems` 打补丁限制条数，并在 `finally` 里还原。

### 写这套测试时踩过的坑（都是测试自身的问题，不是产品缺陷）

- **Obsidian 1.13 的设置页在独立 popout 窗口**，主窗口里找不到设置 DOM，
  `Notice` 也渲染在那个窗口内，且 5s 后自动消失 —— 必须连到设置窗口高频轮询。
- **面板重新挂载会先用控制器里的旧 sessions 渲染**，对 DOM 轮询会命中陈旧
  状态；应直接 `await controller.loadSessions()` 再断言。
- **给 client 打的补丁必须在 `finally` 还原**，否则污染后续用例，
  表现为「会话数莫名变少」这类难查的假失败。
- **验证「停止生成」必须先等真的开始出字**，否则停的是空转，
  测不到截断行为。

## 已通过 E2E 发现的真实缺陷

| 缺陷 | 单测为何没发现 |
|---|---|
| 成功码是 200 而非 0，插件对生产后端完全不可用 | mock 按调研文档写成了 0，等于把错误假设固化进测试 |
| chat 条目无 `chat_id`，会话全部被过滤 | 同上，mock 里给 chat 条目造了 `chat_id` |
| 正文是 HTML 而非 Markdown | 同上 |

结论：**mock 只能验证实现符合假设，不能验证假设本身**。契约类问题
必须打真实后端。
