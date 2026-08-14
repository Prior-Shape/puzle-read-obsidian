import { ITERATE_PAGE_SIZE } from "../../src/core/api/client";
import type { PuzleClient } from "../../src/core/api/client";
import type {
	CommentItem,
	FileReadingDetail,
	HighlightItem,
	LinkReadingDetail,
	PageResponse,
	ReadingItem,
	ReadingSummary
} from "../../src/core/models";

export function makeItem(overrides: Partial<ReadingItem> = {}): ReadingItem {
	return {
		id: 1,
		task_id: 1,
		resource_type: "link",
		resource_id: 1,
		created_time: "2026-03-18T14:46:40Z",
		highlight_count: 0,
		puzle_id: 100,
		domain: "example.com",
		status: "done",
		title: "测试文章",
		...overrides
	};
}

export function makeDetail(
	item: ReadingItem,
	overrides: Partial<LinkReadingDetail> = {}
): LinkReadingDetail {
	return { ...item, content: "正文内容", ...overrides };
}

export function makeHighlight(overrides: Partial<HighlightItem> = {}): HighlightItem {
	return {
		id: 1,
		highlight_type: "text",
		role: "user",
		category: "key_points",
		content: "高亮内容",
		color: "rgba(255,212,0,.4)",
		created_at: "2026-03-18T15:02:11Z",
		location_data: { start_index: 0, end_index: 4 },
		...overrides
	};
}

export function makeComment(overrides: Partial<CommentItem> = {}): CommentItem {
	return {
		id: 1,
		content: "评论内容",
		role: "user",
		created_at: "2026-03-18T16:00:00Z",
		highlight_id: null,
		...overrides
	};
}

export class FakeClient {
	pages: ReadingItem[][] = [];
	listCalls: number[] = [];
	detailCalls: number[] = [];
	summaryCalls: number[] = [];
	highlightCalls: number[] = [];
	commentCalls: number[] = [];
	details = new Map<number, LinkReadingDetail | FileReadingDetail>();
	summaries = new Map<number, ReadingSummary>();
	highlights = new Map<number, HighlightItem[]>();
	comments = new Map<number, CommentItem[]>();
	failDetailFor = new Set<number>();

	get totalItems(): number {
		return this.pages.reduce((count, page) => count + page.length, 0);
	}

	async listReadingItems(params: {
		page?: number;
		page_size?: number;
	}): Promise<PageResponse<ReadingItem>> {
		const page = params.page ?? 1;
		this.listCalls.push(page);
		const items = this.pages[page - 1] ?? [];
		return {
			items,
			total: this.totalItems,
			page,
			page_size: params.page_size ?? ITERATE_PAGE_SIZE
		};
	}

	async *iterateAllReadingItems(): AsyncGenerator<ReadingItem, void, unknown> {
		let page = 1;
		let yielded = 0;
		for (;;) {
			const res = await this.listReadingItems({ page, page_size: ITERATE_PAGE_SIZE });
			for (const item of res.items) {
				yield item;
				yielded += 1;
			}
			if (res.items.length === 0) return;
			if (yielded >= res.total) return;
			if (res.items.length < ITERATE_PAGE_SIZE) return;
			page += 1;
		}
	}

	async getLinkDetail(readingId: number): Promise<LinkReadingDetail> {
		this.detailCalls.push(readingId);
		if (this.failDetailFor.has(readingId)) throw new Error("detail failed");
		const detail = this.details.get(readingId);
		if (!detail) throw new Error(`no detail fixture for reading ${readingId}`);
		return detail as LinkReadingDetail;
	}

	async getFileDetail(readingId: number): Promise<FileReadingDetail> {
		this.detailCalls.push(readingId);
		if (this.failDetailFor.has(readingId)) throw new Error("detail failed");
		const detail = this.details.get(readingId);
		if (!detail) throw new Error(`no detail fixture for reading ${readingId}`);
		return detail as FileReadingDetail;
	}

	async getSummary(readingId: number): Promise<ReadingSummary> {
		this.summaryCalls.push(readingId);
		return this.summaries.get(readingId) ?? {};
	}

	async listHighlightsByReading(readingId: number): Promise<HighlightItem[]> {
		this.highlightCalls.push(readingId);
		return this.highlights.get(readingId) ?? [];
	}

	async listCommentsByReading(readingId: number): Promise<CommentItem[]> {
		this.commentCalls.push(readingId);
		return this.comments.get(readingId) ?? [];
	}

	asClient(): PuzleClient {
		return this as unknown as PuzleClient;
	}
}
