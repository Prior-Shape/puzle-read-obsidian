import { describe, expect, it } from "vitest";
import {
	countOccurrencesBefore,
	locateSelection,
	normalizeCodePoints,
	normalizeUtf16,
	nthOccurrence
} from "../../src/annotations/locate";
import { htmlToPlainText, sliceByCodePoints } from "../../src/annotations/plaintext";
import { htmlToMarkdown } from "../../src/sync/render/html";

describe("normalize", () => {
	it("只保留汉字/字母/数字并记录原文下标", () => {
		const normalized = normalizeUtf16("**Hello**, 世界 42!");
		expect(normalized.text).toBe("hello世界42");
		expect(normalized.index[0]).toBe(2);
		expect("**Hello**, 世界 42!"[normalized.index[5]]).toBe("世");
	});

	it("code point 版按码点计数，emoji 只占一位", () => {
		const normalized = normalizeCodePoints("🙂ab");
		expect(normalized.text).toBe("ab");
		expect(normalized.index).toEqual([1, 2]);
	});
});

describe("occurrence helpers", () => {
	it("统计指定位置之前的出现次数（含重叠）", () => {
		expect(countOccurrencesBefore("abcabcabc", "abc", 6)).toBe(2);
		expect(countOccurrencesBefore("abcabcabc", "abc", 0)).toBe(0);
	});

	it("取第 n 次出现；不够时退到最后一次", () => {
		expect(nthOccurrence("abcabcabc", "abc", 1)).toBe(3);
		expect(nthOccurrence("abcabcabc", "abc", 9)).toBe(6);
		expect(nthOccurrence("abc", "zzz", 0)).toBe(-1);
	});
});

describe("locateSelection", () => {
	const html =
		"<p>阅读可以分为四个层次。</p><p>基础阅读是第一层，检视阅读是第二层。</p><p>阅读可以分为四个层次。</p>";

	it("跨过 Markdown 标记，把选区映射回纯文本偏移", () => {
		const plaintext = htmlToPlainText(html, "raw");
		const markdown = "阅读可以分为四个层次。\n\n基础阅读是第一层，**检视阅读**是第二层。\n\n阅读可以分为四个层次。";
		const start = markdown.indexOf("**检视阅读**");
		const end = start + "**检视阅读**".length;

		const range = locateSelection(markdown, start, end, plaintext);

		expect(range).not.toBeNull();
		expect(sliceByCodePoints(plaintext, range!.start_index, range!.end_index)).toBe("检视阅读");
	});

	it("重复文本按「第几次出现」消歧，命中后一段而不是第一段", () => {
		const plaintext = htmlToPlainText(html, "raw");
		const markdown = htmlToMarkdown(html);
		const needle = "阅读可以分为四个层次";
		const second = markdown.indexOf(needle, markdown.indexOf(needle) + 1);

		const range = locateSelection(markdown, second, second + needle.length, plaintext);

		expect(range).not.toBeNull();
		expect(sliceByCodePoints(plaintext, range!.start_index, range!.end_index)).toBe(needle);
		expect(range!.start_index).toBeGreaterThan(plaintext.indexOf(needle));
	});

	it("选区里没有有效字符时返回 null", () => {
		expect(locateSelection("—— …… ——", 0, 8, "正文")).toBeNull();
	});

	it("正文为空时返回 null", () => {
		expect(locateSelection("阅读", 0, 2, "")).toBeNull();
	});

	it("经过真实 HTML→Markdown 转换后仍能对回原位（含链接与列表）", () => {
		const source =
			"<h2>标题</h2><ul><li>第一条 <a href='https://example.com/a?b=c'>参考链接</a></li>" +
			"<li>第二条要点在这里</li></ul><p>结尾段落。</p>";
		const plaintext = htmlToPlainText(source, "raw");
		const markdown = htmlToMarkdown(source);
		const needle = "第二条要点在这里";
		const at = markdown.indexOf(needle);

		const range = locateSelection(markdown, at, at + needle.length, plaintext);

		expect(range).not.toBeNull();
		expect(sliceByCodePoints(plaintext, range!.start_index, range!.end_index)).toBe(needle);
	});
});
