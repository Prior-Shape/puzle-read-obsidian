import { describe, expect, it } from "vitest";
import { isUnderRoot } from "../../src/vault/reading-mode";
import { normalizeRootFolder } from "../../src/settings";

describe("isUnderRoot", () => {
	it("matches the root folder itself and its descendants", () => {
		expect(isUnderRoot("PuzleRead", "PuzleRead")).toBe(true);
		expect(isUnderRoot("PuzleRead/Articles/a.md", "PuzleRead")).toBe(true);
		expect(isUnderRoot("PuzleRead/Highlights/h.md", "PuzleRead")).toBe(true);
	});

	it("does not match a sibling folder sharing the prefix", () => {
		expect(isUnderRoot("PuzleReadOther/a.md", "PuzleRead")).toBe(false);
	});

	it("tolerates leading/trailing slashes in the configured root", () => {
		expect(isUnderRoot("Notes/Puzle/a.md", "/Notes/Puzle/")).toBe(true);
	});

	it("matches nothing when the root is empty", () => {
		expect(isUnderRoot("a.md", "")).toBe(false);
	});
});

describe("normalizeRootFolder", () => {
	it("strips whitespace and surrounding slashes", () => {
		expect(normalizeRootFolder("  /Notes/Puzle/  ")).toBe("Notes/Puzle");
		expect(normalizeRootFolder("PuzleRead")).toBe("PuzleRead");
		expect(normalizeRootFolder("   ")).toBe("");
	});
});
