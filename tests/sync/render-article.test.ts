import { describe, expect, it } from "vitest";
import type { CommentItem, ReadingItem, ReadingSummary } from "../../src/core/models";
import {
	articleFrontmatter,
	formatTime,
	renderArticleManaged,
	renderSummaryCallout
} from "../../src/sync/render/article";
import { makeComment, makeItem } from "../helpers/fake-client";

const ITEM = makeItem({
	id: 123,
	puzle_id: 1727,
	chat_id: 214,
	title: "如何阅读一本书",
	url: "https://example.com/how-to-read",
	author: "莫提默",
	domain: "example.com",
	status: "done",
	topics: [
		{ id: 1, title: "阅读方法" },
		{ id: 2, title: "学习" }
	],
	created_time: "2026-03-18T14:46:40Z",
	highlight_count: 12,
	comment_count: 3,
	last_comment_at: "2026-03-19T09:00:00Z"
});

const SYNCED_AT = "2026-07-16T12:00:00Z";

describe("articleFrontmatter", () => {
	it("matches the TECH_SPEC 3.2 field set", () => {
		expect(articleFrontmatter(ITEM, SYNCED_AT)).toMatchSnapshot();
	});

	it("fills defaults for missing optional fields", () => {
		const bare = makeItem({
			id: 9,
			title: null,
			url: null,
			author: null,
			status: null,
			chat_id: null,
			topics: null
		});
		expect(articleFrontmatter(bare, SYNCED_AT)).toMatchSnapshot();
	});
});

describe("renderSummaryCallout", () => {
	it("renders all present categories inside one abstract callout", () => {
		const summary: ReadingSummary = {
			key_points: ["阅读有四个层次", "基础阅读是第一层次"],
			new_knowledge: ["检视阅读常被忽略"],
			different_opinions: ["作者认为速读班效果有限"],
			related_information: ["参考《如何阅读两本书》"]
		};
		expect(renderSummaryCallout(summary)).toMatchSnapshot();
	});

	it("omits empty categories and multi-line items keep the callout prefix", () => {
		const summary: ReadingSummary = {
			key_points: ["第一行\n第二行"],
			new_knowledge: [],
			different_opinions: null,
			related_information: ["  "]
		};
		expect(renderSummaryCallout(summary)).toMatchSnapshot();
	});

	it("returns null when nothing is present", () => {
		expect(renderSummaryCallout(null)).toBeNull();
		expect(renderSummaryCallout({})).toBeNull();
		expect(renderSummaryCallout({ key_points: [] })).toBeNull();
	});
});

describe("renderArticleManaged", () => {
	it("renders summary, anchored content, thoughts and the base block", () => {
		const comments: CommentItem[] = [
			makeComment({ id: 1, content: "这篇文章值得反复读", created_at: "2026-03-19T09:00:00Z" }),
			makeComment({
				id: 2,
				content: "确实如此",
				role: "assistant",
				created_at: "2026-03-19T09:05:00Z"
			})
		];
		const managed = renderArticleManaged({
			content:
				"这是一篇关于阅读方法的文章。\n\n==阅读的第一层次是基础阅读。== [[如何阅读一本书 h456|💬]]",
			summary: { key_points: ["阅读有四个层次"] },
			articleComments: comments,
			rootFolder: "PuzleRead"
		});
		expect(managed).toMatchSnapshot();
	});

	it("omits empty sections but always keeps the base block", () => {
		const managed = renderArticleManaged({
			content: "   \n",
			summary: null,
			articleComments: [],
			rootFolder: "MyRoot"
		});
		expect(managed).toMatchSnapshot();
		expect(managed).toContain('file.inFolder("MyRoot/Highlights")');
	});

	it("keeps article-level comments in chronological order", () => {
		const managed = renderArticleManaged({
			content: "正文",
			summary: null,
			articleComments: [
				makeComment({ id: 2, content: "后发的", created_at: "2026-03-20T00:00:00Z" }),
				makeComment({ id: 1, content: "先发的", created_at: "2026-03-19T00:00:00Z" })
			],
			rootFolder: "PuzleRead"
		});
		expect(managed.indexOf("先发的")).toBeLessThan(managed.indexOf("后发的"));
		expect(managed).toMatchSnapshot();
	});
});

describe("formatTime", () => {
	it("formats ISO strings without timezone conversion", () => {
		expect(formatTime("2026-03-18T15:02:11Z")).toBe("2026-03-18 15:02");
		expect(formatTime("2026-03-18 15:02:11")).toBe("2026-03-18 15:02");
	});

	it("returns the input for unparseable values and empty for missing", () => {
		expect(formatTime("昨天")).toBe("昨天");
		expect(formatTime(null)).toBe("");
		expect(formatTime(undefined)).toBe("");
	});
});

describe("article managed region stability", () => {
	it("does not depend on wall-clock time (only on inputs)", () => {
		const input = {
			content: "正文",
			summary: { key_points: ["要点"] } as ReadingSummary,
			articleComments: [makeComment()],
			rootFolder: "PuzleRead"
		};
		expect(renderArticleManaged(input)).toBe(renderArticleManaged(input));
	});

	it("frontmatter of a real item", () => {
		const item: ReadingItem = ITEM;
		const fm = articleFrontmatter(item, SYNCED_AT);
		expect(Object.keys(fm)).toEqual([
			"puzle_type",
			"reading_id",
			"puzle_id",
			"chat_id",
			"title",
			"url",
			"author",
			"domain",
			"status",
			"topics",
			"created",
			"synced",
			"highlight_count",
			"comment_count"
		]);
	});
});
