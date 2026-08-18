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

## 对接真实后端

把沙箱 vault 的 `data.json` 里的 `baseUrl` / `token` 换成真实值即可。
注意：
- 同步是只读的（全部 GET），但**发消息/续写会在账号里产生真实会话**；
- 全量同步会对每篇文章发 4 个请求，账号文章多时建议临时给
  `client.iterateAllReadingItems` 打补丁限制条数（见 run.mjs 的做法）。

## 已通过 E2E 发现的真实缺陷

| 缺陷 | 单测为何没发现 |
|---|---|
| 成功码是 200 而非 0，插件对生产后端完全不可用 | mock 按调研文档写成了 0，等于把错误假设固化进测试 |
| chat 条目无 `chat_id`，会话全部被过滤 | 同上，mock 里给 chat 条目造了 `chat_id` |
| 正文是 HTML 而非 Markdown | 同上 |

结论：**mock 只能验证实现符合假设，不能验证假设本身**。契约类问题
必须打真实后端。
