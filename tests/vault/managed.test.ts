import { describe, expect, it } from "vitest";
import {
	extractManagedInner,
	findManagedRegion,
	hashManaged,
	MANAGED_BEGIN_MARKER,
	MANAGED_END_MARKER,
	upsertManagedRegion,
	wrapManaged,
} from "../../src/vault/managed";

const BEGIN = MANAGED_BEGIN_MARKER;
const END = MANAGED_END_MARKER;

describe("wrapManaged", () => {
	it("wraps the body with begin/end markers", () => {
		expect(wrapManaged("## 摘要\n内容")).toBe(`${BEGIN}\n## 摘要\n内容\n${END}`);
	});

	it("trims surrounding blank lines from the body", () => {
		expect(wrapManaged("\n\n内容\n\n")).toBe(`${BEGIN}\n内容\n${END}`);
	});

	it("handles an empty body", () => {
		expect(wrapManaged("")).toBe(`${BEGIN}\n${END}`);
	});
});

describe("findManagedRegion", () => {
	it("returns null when there is no begin marker", () => {
		expect(findManagedRegion("# 标题\n\n用户内容")).toBeNull();
	});

	it("locates the region and its inner content", () => {
		const content = `前言\n${BEGIN}\ninner line\n${END}\n后记`;
		const region = findManagedRegion(content);
		expect(region).not.toBeNull();
		expect(region!.inner).toBe("inner line");
		expect(region!.truncated).toBe(false);
		expect(content.slice(region!.start, region!.end)).toBe(
			`${BEGIN}\ninner line\n${END}`,
		);
	});

	it("treats a missing end marker as a region extending to EOF", () => {
		const content = `前言\n${BEGIN}\ninner`;
		const region = findManagedRegion(content);
		expect(region).not.toBeNull();
		expect(region!.truncated).toBe(true);
		expect(region!.inner).toBe("inner");
		expect(region!.end).toBe(content.length);
	});
});

describe("extractManagedInner", () => {
	it("returns the inner content", () => {
		expect(extractManagedInner(`a\n${BEGIN}\nbody\n${END}\nb`)).toBe("body");
	});

	it("returns null when no region exists", () => {
		expect(extractManagedInner("no markers here")).toBeNull();
	});
});

describe("upsertManagedRegion", () => {
	it("creates a region in an empty document", () => {
		expect(upsertManagedRegion("", "managed")).toBe(`${BEGIN}\nmanaged\n${END}\n`);
	});

	it("appends a region to a document without one, preserving prior content", () => {
		const result = upsertManagedRegion("# 标题\n\n用户正文", "managed");
		expect(result.startsWith("# 标题\n\n用户正文\n\n")).toBe(true);
		expect(result.endsWith(`${BEGIN}\nmanaged\n${END}\n`)).toBe(true);
	});

	it("replaces an existing region in place", () => {
		const original = `前言\n${BEGIN}\n旧内容\n${END}\n后记`;
		const result = upsertManagedRegion(original, "新内容");
		expect(result).toBe(`前言\n${BEGIN}\n新内容\n${END}\n后记`);
	});

	it("preserves content outside the managed region", () => {
		const frontmatter = "---\ntitle: 文章\n---\n\n";
		const userBefore = "用户在区前写的笔记";
		const userAfter = "用户在区后写的笔记";
		const original = `${frontmatter}${userBefore}\n\n${BEGIN}\nmanaged v1\n${END}\n\n${userAfter}`;
		const result = upsertManagedRegion(original, "managed v2");

		expect(result).toContain(frontmatter.trim());
		expect(result).toContain(userBefore);
		expect(result).toContain(userAfter);
		expect(result).not.toContain("managed v1");
		expect(result).toContain(`${BEGIN}\nmanaged v2\n${END}`);
		expect(result.indexOf(userBefore)).toBeLessThan(result.indexOf(BEGIN));
		expect(result.indexOf(END)).toBeLessThan(result.indexOf(userAfter));
	});

	it("is idempotent for identical repeated writes", () => {
		const once = upsertManagedRegion("正文", "managed");
		const twice = upsertManagedRegion(once, "managed");
		expect(twice).toBe(once);
	});

	it("tolerates a missing end marker by rewriting from begin to EOF", () => {
		const original = `前言\n${BEGIN}\n残留的旧内容`;
		const result = upsertManagedRegion(original, "新内容");
		expect(result).toBe(`前言\n${BEGIN}\n新内容\n${END}\n`);
		expect(result).toContain("前言");
		expect(result).not.toContain("残留的旧内容");
		const region = findManagedRegion(result);
		expect(region!.truncated).toBe(false);
	});

	it("keeps a trailing newline when the region ends the file", () => {
		const original = `前言\n${BEGIN}\n旧\n${END}\n`;
		const result = upsertManagedRegion(original, "新");
		expect(result).toBe(`前言\n${BEGIN}\n新\n${END}\n`);
	});
});

describe("hashManaged", () => {
	it("is deterministic", () => {
		expect(hashManaged("abc")).toBe(hashManaged("abc"));
	});

	it("differs for different content", () => {
		expect(hashManaged("abc")).not.toBe(hashManaged("abd"));
	});

	it("returns an 8-char hex string", () => {
		expect(hashManaged("任意内容")).toMatch(/^[0-9a-f]{8}$/);
	});
});
