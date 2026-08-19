# Puzle Read 工作区

此文件夹（`PuzleRead/`）由 Puzle Read 插件生成，用于存放从 Puzle 同步的阅读内容。

## 文件夹说明

- `Articles/` — 文章笔记，每篇已读文章一个文件，frontmatter 含 `reading_id` 等元数据。
- `Highlights/` — 高亮笔记，每条高亮一个文件，`article` 属性链接到所属文章。
- `Chats/` — 与 Puzle AI 的对话记录；右边栏聊天面板每说完一轮就会就地更新对应文件。

## Base 视图入口

- `PuzleRead/Articles.base` — 全部文章（含「按主题」分组与「最近阅读」卡片视图）。
- `PuzleRead/Highlights.base` — 全部高亮（含「按分类」「按文章」分组视图）。

直接打开对应的 `.base` 文件即可浏览，也可以在任意笔记中用 `![[Articles.base]]` 嵌入。

## 注意事项

- 每个文件中 `%% puzle:begin %%` 与 `%% puzle:end %%` 之间的内容（managed 区）由插件在每次同步时全量重写，**请勿编辑**，其中的修改会在下次同步时丢失。
- managed 区之外的内容完全属于你，插件永不触碰，可自由编辑与追加笔记。
- 重命名或移动文件没有问题：插件通过 frontmatter 中的 id 定位文件，不依赖文件名。
