import { describe, expect, it } from "vitest";
import { pickBest, scoreVariants } from "../../src/annotations/calibrate";
import { codePointLength, htmlToPlainText, sliceByCodePoints } from "../../src/annotations/plaintext";
import type { HighlightItem } from "../../src/core/models";

const HTML = "<p>阅读可以分为四个层次。</p><p>基础阅读是第一层。</p><script>var x = 1;</script>";

describe("htmlToPlainText", () => {
	it("raw 口径原样拼接文本节点，块之间不插分隔符", () => {
		expect(htmlToPlainText(HTML, "raw")).toBe("阅读可以分为四个层次。基础阅读是第一层。");
	});

	it("blockNewline 在块级元素后补换行", () => {
		expect(htmlToPlainText(HTML, "blockNewline")).toBe("阅读可以分为四个层次。\n基础阅读是第一层。\n");
	});

	it("collapse 口径折叠空白并去掉首尾空白", () => {
		const html = "<p>  多余   空白  </p><p>第二段</p>";
		expect(htmlToPlainText(html, "collapseNewline")).toBe("多余 空白\n第二段");
		expect(htmlToPlainText(html, "collapseDoubleNewline")).toBe("多余 空白\n\n第二段");
	});

	it("丢弃 script/style 的内容", () => {
		expect(htmlToPlainText(HTML, "raw")).not.toContain("var x");
	});

	it("<br> 变换行", () => {
		expect(htmlToPlainText("<p>上<br>下</p>", "raw")).toBe("上\n下");
	});

	it("空输入返回空串", () => {
		expect(htmlToPlainText("", "raw")).toBe("");
	});
});

describe("code point 切片", () => {
	it("按码点切，emoji 不会被劈成两半", () => {
		expect(sliceByCodePoints("a🙂b", 1, 2)).toBe("🙂");
		expect(codePointLength("a🙂b")).toBe(3);
	});

	it("越界返回空串", () => {
		expect(sliceByCodePoints("abc", 0, 99)).toBe("");
		expect(sliceByCodePoints("abc", 2, 1)).toBe("");
	});
});

function highlight(partial: Partial<HighlightItem> & { id: number; content: string; start: number; end: number }): HighlightItem {
	return {
		id: partial.id,
		highlight_type: "text",
		role: "user",
		category: "key_points",
		content: partial.content,
		created_at: "2026-08-01T00:00:00Z",
		location_data: { start_index: partial.start, end_index: partial.end }
	};
}

describe("scoreVariants / pickBest", () => {
	it("用已有高亮当标准答案，选出能精确还原的口径", () => {
		const plaintext = htmlToPlainText(HTML, "raw");
		const content = "基础阅读";
		const start = Array.from(plaintext).findIndex((_, index) =>
			sliceByCodePoints(plaintext, index, index + content.length) === content
		);
		const samples = [
			{ html: HTML, highlights: [highlight({ id: 1, content, start, end: start + content.length })] }
		];

		const scores = scoreVariants(samples);
		const best = pickBest(scores);

		expect(best?.variant).toBe("raw");
		expect(best?.exact).toBe(1);
		expect(best?.total).toBe(1);
	});

	it("没有可用高亮时 total 为 0，pickBest 返回 null", () => {
		const scores = scoreVariants([{ html: HTML, highlights: [] }]);
		expect(scores.every((score) => score.total === 0)).toBe(true);
		expect(pickBest(scores)).toBeNull();
	});

	it("跳过缺 content 或区间非法的高亮，不计入分母", () => {
		const samples = [
			{
				html: HTML,
				highlights: [
					highlight({ id: 1, content: "   ", start: 0, end: 2 }),
					highlight({ id: 2, content: "阅读", start: 5, end: 5 })
				]
			}
		];
		expect(scoreVariants(samples).every((score) => score.total === 0)).toBe(true);
	});
});
