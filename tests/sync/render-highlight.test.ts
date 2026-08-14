import { describe, expect, it } from "vitest";
import {
	highlightFrontmatter,
	renderHighlightManaged
} from "../../src/sync/render/highlight";
import { makeComment, makeHighlight } from "../helpers/fake-client";

describe("highlightFrontmatter", () => {
	it("matches the TECH_SPEC 3.3 field set", () => {
		const highlight = makeHighlight({
			id: 456,
			category: "key_points",
			role: "user",
			color: "rgba(255,212,0,.4)",
			created_at: "2026-03-18T15:02:11Z"
		});
		expect(highlightFrontmatter(highlight, 123, "如何阅读一本书 (r123)")).toMatchSnapshot();
	});

	it("uses null color when missing and assistant role is preserved", () => {
		const highlight = makeHighlight({ id: 7, role: "assistant", color: null });
		expect(highlightFrontmatter(highlight, 9, "文章 (r9)")).toMatchSnapshot();
	});
});

describe("renderHighlightManaged", () => {
	it("renders the quote and attached comments with role markers", () => {
		const managed = renderHighlightManaged({
			highlight: makeHighlight({
				id: 456,
				content: "阅读的第一层次是基础阅读。\n第二行内容。"
			}),
			comments: [
				makeComment({ id: 1, content: "这点和主题阅读呼应", created_at: "2026-03-18T16:00:00Z" }),
				makeComment({
					id: 2,
					content: "是的",
					role: "assistant",
					created_at: "2026-03-18T16:05:00Z"
				})
			]
		});
		expect(managed).toMatchSnapshot();
		expect(managed).toContain("🙋 我");
		expect(managed).toContain("🤖 Puzle");
	});

	it("renders only the quote when there are no comments", () => {
		const managed = renderHighlightManaged({
			highlight: makeHighlight({ content: "只有高亮" }),
			comments: []
		});
		expect(managed).toMatchSnapshot();
		expect(managed).not.toContain("## 想法");
	});

	it("renders an empty body for content-less highlights without comments", () => {
		const managed = renderHighlightManaged({
			highlight: makeHighlight({ content: null }),
			comments: []
		});
		expect(managed).toBe("");
	});
});
