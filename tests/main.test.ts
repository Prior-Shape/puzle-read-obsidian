import { describe, expect, it } from "vitest";
import { deriveWsUrl } from "../src/main";

describe("deriveWsUrl", () => {
	it("converts https base url to wss endpoint", () => {
		expect(deriveWsUrl("https://read-web-test.puzle.com.cn")).toBe(
			"wss://read-web-test.puzle.com.cn/api/v1/agent/events"
		);
	});

	it("converts http base url to ws endpoint", () => {
		expect(deriveWsUrl("http://localhost:8080")).toBe("ws://localhost:8080/api/v1/agent/events");
	});

	it("keeps a path prefix in the base url", () => {
		expect(deriveWsUrl("https://read-dev.prior-shape.com/puzle-read")).toBe(
			"wss://read-dev.prior-shape.com/puzle-read/api/v1/agent/events"
		);
	});

	it("trims whitespace and trailing slashes", () => {
		expect(deriveWsUrl("  https://example.com///  ")).toBe("wss://example.com/api/v1/agent/events");
	});

	it("assumes https for scheme-less input", () => {
		expect(deriveWsUrl("example.com")).toBe("wss://example.com/api/v1/agent/events");
	});

	it("returns empty string for empty input", () => {
		expect(deriveWsUrl("")).toBe("");
		expect(deriveWsUrl("   ")).toBe("");
	});
});
