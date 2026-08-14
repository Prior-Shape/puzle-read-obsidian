import { describe, expect, it } from "vitest";
import { injectAnchors, type AnchorHighlight } from "../../src/sync/anchor";

const H = (
	id: number,
	content: string,
	start_index: number,
	linkTarget?: string,
): AnchorHighlight => ({
	id,
	content,
	start_index,
	linkTarget: linkTarget ?? `Highlights/article h${id}`,
});

describe("injectAnchors", () => {
	it("中文引用：命中后包裹 ==…== 并插入角标链接", () => {
		const md =
			"这是一篇关于阅读方法的文章。\n\n阅读的第一层次是基础阅读。\n\n以上就是全部内容。";
		const res = injectAnchors(md, [H(1, "阅读的第一层次是基础阅读。", 13)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"这是一篇关于阅读方法的文章。\n\n==阅读的第一层次是基础阅读。== [[Highlights/article h1|💬]]\n\n以上就是全部内容。",
		);
	});

	it("英文引用：命中后包裹并插入角标链接", () => {
		const md =
			"Reading is a skill.\n\nThe first level of reading is elementary reading.\n\nThat is all.";
		const res = injectAnchors(md, [H(2, "first level of reading", 24)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"Reading is a skill.\n\nThe ==first level of reading== [[Highlights/article h2|💬]] is elementary reading.\n\nThat is all.",
		);
	});

	it("同一句子多处出现：按 start_index 相对次序贪心对位", () => {
		const md = "甲段。这句话很重要。乙段。这句话很重要。丙段。这句话很重要。丁段。";
		const h1 = H(10, "这句话很重要。", 100);
		const h2 = H(20, "这句话很重要。", 2);
		const res = injectAnchors(md, [h1, h2]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"甲段。==这句话很重要。== [[Highlights/article h20|💬]]乙段。==这句话很重要。== [[Highlights/article h10|💬]]丙段。这句话很重要。丁段。",
		);
	});

	it("同一句子多处出现：单条高亮命中第一处", () => {
		const md = "甲段。这句话很重要。乙段。这句话很重要。";
		const res = injectAnchors(md, [H(30, "这句话很重要。", 50)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"甲段。==这句话很重要。== [[Highlights/article h30|💬]]乙段。这句话很重要。",
		);
	});

	it("跨两段的引用：逐段分别包裹，角标只插在末段", () => {
		const md = "第一段有开头的内容和结尾句。\n\n第二段有开始的内容和收尾。";
		const res = injectAnchors(md, [H(3, "结尾句。\n\n第二段有开始", 8)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"第一段有开头的内容和==结尾句。==\n\n==第二段有开始== [[Highlights/article h3|💬]]的内容和收尾。",
		);
	});

	it("代码块内出现相同文本时不误标", () => {
		const md =
			'```ts\nconst s = "重复文本";\nconsole.log(s);\n```\n\n正文里有重复文本这一句。';
		const res = injectAnchors(md, [H(4, "重复文本", 0)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			'```ts\nconst s = "重复文本";\nconsole.log(s);\n```\n\n正文里有==重复文本== [[Highlights/article h4|💬]]这一句。',
		);
	});

	it("仅出现在代码块/行内代码中的文本：miss 且正文不动", () => {
		const fenceOnly = '```\n只在围栏里的句子\n```\n\n正文其他内容。';
		const r1 = injectAnchors(fenceOnly, [H(5, "只在围栏里的句子", 0)]);
		expect(r1.misses).toEqual([expect.objectContaining({ id: 5 })]);
		expect(r1.markdown).toBe(fenceOnly);

		const inline = "先调用 `repeat(text)` 再说。";
		const r2 = injectAnchors(inline, [H(6, "repeat(text)", 0)]);
		expect(r2.misses).toEqual([expect.objectContaining({ id: 6 })]);
		expect(r2.markdown).toBe(inline);
	});

	it("引用原文含 **加粗** 与 [链接](url) 时仍能命中（内容为渲染纯文本）", () => {
		const md = "这是**非常重要**的概念，参见[官方文档](https://example.com)的说明。";
		const res = injectAnchors(md, [
			H(7, "这是非常重要的概念，参见官方文档的说明", 0),
		]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"==这是**非常重要**的概念，参见[官方文档](https://example.com)的说明== [[Highlights/article h7|💬]]。",
		);
	});

	it("引用内容本身带有标记符号时也能命中", () => {
		const md = "这是**非常重要**的概念，参见[官方文档](https://example.com)的说明。";
		const res = injectAnchors(md, [H(8, "这是**非常重要**的概念", 0)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"==这是**非常重要**的概念== [[Highlights/article h8|💬]]，参见[官方文档](https://example.com)的说明。",
		);
	});

	it("空高亮列表：正文原样返回", () => {
		const md = "任意内容。\n\n第二段。";
		const res = injectAnchors(md, []);
		expect(res.markdown).toBe(md);
		expect(res.misses).toEqual([]);
	});

	it("全部未命中：正文不动，misses 按输入顺序返回", () => {
		const md = "正文只有这些。";
		const hs = [H(9, "不存在的句子", 0), H(11, "也没有这句", 5)];
		const res = injectAnchors(md, hs);
		expect(res.markdown).toBe(md);
		expect(res.misses).toEqual(hs);
	});

	it("frontmatter 与 %% 注释中的文本不参与匹配", () => {
		const md =
			"---\ntitle: 秘密标题abc123\n---\n\n%%注释里有abc123%%\n\n正文句子abc123结束。";
		const res = injectAnchors(md, [H(12, "abc123", 0)]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"---\ntitle: 秘密标题abc123\n---\n\n%%注释里有abc123%%\n\n正文句子==abc123== [[Highlights/article h12|💬]]结束。",
		);

		const onlyInMeta = injectAnchors(md, [H(13, "秘密标题", 0)]);
		expect(onlyInMeta.misses).toEqual([expect.objectContaining({ id: 13 })]);
		expect(onlyInMeta.markdown).toBe(md);
	});

	it("跨行 %% 注释中的文本不参与匹配", () => {
		const md = "前面文字。\n\n%%\n隐藏段落内容\n%%\n\n后面文字。";
		const res = injectAnchors(md, [H(14, "隐藏段落内容", 0)]);
		expect(res.misses).toEqual([expect.objectContaining({ id: 14 })]);
		expect(res.markdown).toBe(md);
	});

	it("多条高亮同时命中互不重叠", () => {
		const md = "第一句话在这里。\n\n第二句话在那里。\n\n第三句话在远处。";
		const res = injectAnchors(md, [
			H(15, "第二句话在那里。", 30),
			H(16, "第一句话在这里。", 3),
		]);
		expect(res.misses).toEqual([]);
		expect(res.markdown).toBe(
			"==第一句话在这里。== [[Highlights/article h16|💬]]\n\n==第二句话在那里。== [[Highlights/article h15|💬]]\n\n第三句话在远处。",
		);
	});
});
