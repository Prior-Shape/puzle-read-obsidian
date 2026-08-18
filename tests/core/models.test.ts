import { describe, expect, it } from "vitest";
import { isChatReadingItem, resolveChatId } from "../../src/core/models";
import type { ReadingItem, ResourceType } from "../../src/core/models";

function item(partial: Partial<ReadingItem> & { id: number; resource_type: ResourceType }): ReadingItem {
	return {
		task_id: 0,
		resource_id: partial.id,
		created_time: "2026-08-05T12:00:00Z",
		highlight_count: 0,
		puzle_id: 1,
		domain: "",
		...partial
	};
}

describe("resolveChatId", () => {
	it("prefers an explicit chat_id (link/file items point at their chat)", () => {
		expect(resolveChatId(item({ id: 2833, resource_id: 2606, resource_type: "link", chat_id: 807 }))).toBe(807);
	});

	// 生产环境 (read-web.puzle.com.cn) 的 chat 条目根本不返回 chat_id 字段，
	// 会话 id 就是 resource_id；只认 chat_id 会让所有会话被静默过滤掉。
	it("falls back to resource_id for chat items without chat_id", () => {
		expect(resolveChatId(item({ id: 762, resource_id: 762, resource_type: "chat" }))).toBe(762);
	});

	it("falls back to id when resource_id is missing", () => {
		const raw = { ...item({ id: 762, resource_type: "chat" }), resource_id: undefined } as unknown as ReadingItem;
		expect(resolveChatId(raw)).toBe(762);
	});

	it("ignores a null chat_id on chat items", () => {
		expect(resolveChatId(item({ id: 195, resource_id: 195, resource_type: "chat", chat_id: null }))).toBe(195);
	});

	it("returns null for non-chat items without a chat_id", () => {
		expect(resolveChatId(item({ id: 2860, resource_type: "link" }))).toBeNull();
		expect(resolveChatId(item({ id: 2860, resource_type: "file", chat_id: null }))).toBeNull();
	});
});

describe("isChatReadingItem", () => {
	it("accepts production chat items that carry no chat_id", () => {
		const raw = {
			id: 762,
			puzle_id: 3830,
			resource_type: "chat",
			resource_id: 762,
			created_time: "2026-07-18T19:59:58.805083+08:00",
			title: "⛓️ Harness 反技术债准则",
			status: "completed"
		} as unknown as ReadingItem;
		expect(isChatReadingItem(raw)).toBe(true);
		expect(resolveChatId(raw)).toBe(762);
	});

	it("accepts chat items that do carry chat_id", () => {
		expect(isChatReadingItem(item({ id: 501, resource_type: "chat", chat_id: 214 }))).toBe(true);
	});

	it("rejects link and file items even when they reference a chat", () => {
		expect(isChatReadingItem(item({ id: 2833, resource_type: "link", chat_id: 807 }))).toBe(false);
		expect(isChatReadingItem(item({ id: 102, resource_type: "file" }))).toBe(false);
	});
});
