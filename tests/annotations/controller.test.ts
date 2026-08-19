import { describe, expect, it } from "vitest";
import { AnnotationsController, groupAnnotations } from "../../src/annotations/controller";
import type { PuzleClient } from "../../src/core/api/client";
import { findSnippetLine, normalizeForMatch } from "../../src/annotations/reveal";
import type { CommentItem, HighlightItem } from "../../src/core/models";

function highlight(
	partial: Partial<HighlightItem> & { id: number; start?: number }
): HighlightItem {
	return {
		highlight_type: "text",
		role: "user",
		category: "key_points",
		content: `高亮 ${partial.id}`,
		created_at: "2026-08-01T00:00:00Z",
		location_data: { start_index: partial.start ?? 0, end_index: (partial.start ?? 0) + 4 },
		...partial
	} as HighlightItem;
}

function comment(partial: Partial<CommentItem> & { id: number }): CommentItem {
	return {
		content: `想法 ${partial.id}`,
		created_at: "2026-08-01T00:00:00Z",
		...partial
	} as CommentItem;
}

describe("groupAnnotations", () => {
	it("高亮按正文顺序排列，评论按 highlight_id 归位", () => {
		const grouped = groupAnnotations(
			[highlight({ id: 2, start: 100 }), highlight({ id: 1, start: 10 })],
			[
				comment({ id: 11, highlight_id: 1 }),
				comment({ id: 12, highlight_id: 2 }),
				comment({ id: 13, highlight_id: null })
			]
		);

		expect(grouped.entries.map((entry) => entry.highlight.id)).toEqual([1, 2]);
		expect(grouped.entries[0].comments.map((c) => c.id)).toEqual([11]);
		expect(grouped.articleComments.map((c) => c.id)).toEqual([13]);
	});

	it("hidden 的高亮不展示", () => {
		const grouped = groupAnnotations([highlight({ id: 1, hidden: true })], []);
		expect(grouped.entries).toEqual([]);
	});

	it("挂在不存在高亮上的孤儿评论并进文章级，不会丢", () => {
		const grouped = groupAnnotations([highlight({ id: 1 })], [comment({ id: 99, highlight_id: 777 })]);
		expect(grouped.articleComments.map((c) => c.id)).toEqual([99]);
	});

	it("缺 start_index 的高亮排到最后", () => {
		const noLocation = { ...highlight({ id: 5 }), location_data: undefined } as unknown as HighlightItem;
		const grouped = groupAnnotations([noLocation, highlight({ id: 6, start: 3 })], []);
		expect(grouped.entries.map((entry) => entry.highlight.id)).toEqual([6, 5]);
	});

	it("同一条高亮下的评论按时间升序", () => {
		const grouped = groupAnnotations(
			[highlight({ id: 1 })],
			[
				comment({ id: 2, highlight_id: 1, created_at: "2026-08-02T00:00:00Z" }),
				comment({ id: 1, highlight_id: 1, created_at: "2026-08-01T00:00:00Z" })
			]
		);
		expect(grouped.entries[0].comments.map((c) => c.id)).toEqual([1, 2]);
	});
});

describe("findSnippetLine", () => {
	const note = [
		"---",
		"puzle_type: article",
		"---",
		"",
		"## 正文",
		"",
		"阅读可以分为四个层次。",
		"",
		"==基础阅读是第一层== [[Highlights/x h1|💬]]，检视阅读是第二层。"
	].join("\n");

	it("跳过 Markdown 标记与角标，定位到高亮所在行", () => {
		expect(findSnippetLine(note, "基础阅读是第一层")).toBe(8);
		expect(findSnippetLine(note, "阅读可以分为四个层次")).toBe(6);
	});

	it("整段匹配不到时退化成前缀匹配", () => {
		expect(findSnippetLine(note, "基础阅读是第一层，但这后半句原文里没有")).toBe(8);
	});

	it("完全找不到返回 null", () => {
		expect(findSnippetLine(note, "这段话根本不在文章里出现过")).toBeNull();
	});

	it("归一化丢掉标点与空白", () => {
		expect(normalizeForMatch("**Hello**, 世界！").text).toBe("hello世界");
	});
});

describe("AnnotationsController 写回与删除", () => {
	class FakeAnnotationsClient {
		highlights: HighlightItem[] = [highlight({ id: 1 })];
		comments: CommentItem[] = [comment({ id: 11, highlight_id: 1 }), comment({ id: 12, highlight_id: null })];
		deletedHighlights: number[] = [];
		deletedComments: number[] = [];
		failWith: Error | null = null;

		async listHighlightsByReading(): Promise<HighlightItem[]> {
			return this.highlights;
		}

		async listCommentsByReading(): Promise<CommentItem[]> {
			return this.comments;
		}

		async deleteHighlight(id: number): Promise<unknown> {
			if (this.failWith) throw this.failWith;
			this.deletedHighlights.push(id);
			this.highlights = this.highlights.filter((h) => h.id !== id);
			this.comments = this.comments.filter((c) => c.highlight_id !== id);
			return null;
		}

		async deleteComment(id: number): Promise<unknown> {
			if (this.failWith) throw this.failWith;
			this.deletedComments.push(id);
			this.comments = this.comments.filter((c) => c.id !== id);
			return null;
		}

		asClient(): PuzleClient {
			return this as unknown as PuzleClient;
		}
	}

	async function setup() {
		const client = new FakeAnnotationsClient();
		const notices: string[] = [];
		const refreshed: number[] = [];
		const controller = new AnnotationsController(() => client.asClient(), {
			notice: (message) => notices.push(message),
			onAnnotationsChanged: (readingId) => refreshed.push(readingId)
		});
		await controller.setArticle({ readingId: 101, title: "文章", path: "PuzleRead/Articles/a.md" });
		return { client, controller, notices, refreshed };
	}

	it("删除高亮：调接口、重新拉取、刷新文章笔记、给提示", async () => {
		const { client, controller, notices, refreshed } = await setup();

		expect(await controller.deleteHighlight(1)).toBe(true);

		expect(client.deletedHighlights).toEqual([1]);
		expect(controller.getState().entries).toEqual([]);
		// 挂在这条高亮下的想法也一并消失
		expect(controller.getState().articleComments.map((c) => c.id)).toEqual([12]);
		expect(refreshed).toEqual([101]);
		expect(notices).toEqual(["已删除这条高亮"]);
	});

	it("删除想法：只掉那一条，高亮还在", async () => {
		const { client, controller, notices } = await setup();

		expect(await controller.deleteComment(12)).toBe(true);

		expect(client.deletedComments).toEqual([12]);
		expect(controller.getState().articleComments).toEqual([]);
		expect(controller.getState().entries.map((e) => e.highlight.id)).toEqual([1]);
		expect(notices).toEqual(["已删除这条想法"]);
	});

	// 后端若不许删 AI 生成的高亮，用户要看到服务端原话，而不是静默失败
	it("后端拒绝时返回 false，把服务端的话透出来", async () => {
		const { client, controller, notices, refreshed } = await setup();
		client.failWith = new Error("AI 高亮不可删除");

		expect(await controller.deleteHighlight(1)).toBe(false);

		expect(controller.getState().entries.map((e) => e.highlight.id)).toEqual([1]);
		expect(controller.getState().error).toBe("AI 高亮不可删除");
		expect(controller.getState().submitting).toBe(false);
		expect(refreshed).toEqual([]);
		expect(notices).toEqual(["删除高亮失败：AI 高亮不可删除"]);
	});

	it("没有当前文章时不发请求", async () => {
		const client = new FakeAnnotationsClient();
		const controller = new AnnotationsController(() => client.asClient());

		expect(await controller.deleteHighlight(1)).toBe(false);
		expect(client.deletedHighlights).toEqual([]);
	});
});
