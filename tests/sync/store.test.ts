import { describe, expect, it } from "vitest";
import { mergePluginData } from "../../src/settings";
import { SyncStore } from "../../src/sync/store";

function makeStore(): { store: SyncStore; flushes: number } {
	const data = mergePluginData(null);
	let flushes = 0;
	const store = new SyncStore({
		getData: () => data,
		saveData: async () => {
			flushes += 1;
		}
	});
	return { store, flushes };
}

describe("SyncStore", () => {
	it("reads and writes article/highlight/chat state by numeric id", () => {
		const { store } = makeStore();
		store.setArticle(123, {
			path: "PuzleRead/Articles/a.md",
			fingerprint: "fp",
			managedHash: "mh",
			syncedAt: "2026-08-10T00:00:00Z"
		});
		store.setHighlight(456, { path: "PuzleRead/Highlights/b.md", managedHash: "mh", readingId: 123 });
		store.setChat(214, { path: "PuzleRead/Chats/c.md", turnCount: 3, managedHash: "mh" });

		expect(store.getArticle(123)?.fingerprint).toBe("fp");
		expect(store.getHighlight(456)?.readingId).toBe(123);
		expect(store.getChat(214)?.turnCount).toBe(3);
		expect(store.articleEntries().map(([id]) => id)).toEqual([123]);
		expect(store.highlightEntries().map(([id]) => id)).toEqual([456]);
		expect(store.chatEntries().map(([id]) => id)).toEqual([214]);

		store.deleteArticle(123);
		store.deleteHighlight(456);
		store.deleteChat(214);
		expect(store.getArticle(123)).toBeUndefined();
		expect(store.getHighlight(456)).toBeUndefined();
		expect(store.getChat(214)).toBeUndefined();
	});

	it("tracks lastSyncAt", () => {
		const { store } = makeStore();
		expect(store.lastSyncAt).toBeNull();
		store.setLastSyncAt("2026-08-10T00:00:00Z");
		expect(store.lastSyncAt).toBe("2026-08-10T00:00:00Z");
	});

	// 续写功能已下线，但老 data.json 里可能还留着那个会话 id，读得到才挡得住
	it("reads the legacy continuationChatId from saved data", () => {
		const data = mergePluginData({ syncState: { continuationChatId: 77 } });
		const store = new SyncStore({ getData: () => data, saveData: async () => undefined });
		expect(store.continuationChatId).toBe(77);
		expect(makeStore().store.continuationChatId).toBeNull();
	});

	it("flush persists through the backend saveData", async () => {
		const data = mergePluginData(null);
		let flushes = 0;
		const store = new SyncStore({
			getData: () => data,
			saveData: async () => {
				flushes += 1;
			}
		});
		await store.flush();
		await store.flush();
		expect(flushes).toBe(2);
	});

	it("handleRename updates stored paths across all collections", () => {
		const { store } = makeStore();
		store.setArticle(1, {
			path: "PuzleRead/Articles/old.md",
			fingerprint: "fp",
			managedHash: "mh",
			syncedAt: "now"
		});
		store.setHighlight(2, { path: "PuzleRead/Highlights/old.md", managedHash: "mh", readingId: 1 });
		store.setChat(3, { path: "PuzleRead/Chats/old.md", turnCount: 1, managedHash: "mh" });

		expect(store.handleRename("PuzleRead/Articles/old.md", "PuzleRead/Articles/new.md")).toBe(true);
		expect(store.getArticle(1)?.path).toBe("PuzleRead/Articles/new.md");

		expect(store.handleRename("PuzleRead/Highlights/old.md", "Notes/h.md")).toBe(true);
		expect(store.getHighlight(2)?.path).toBe("Notes/h.md");

		expect(store.handleRename("PuzleRead/Chats/old.md", "PuzleRead/Chats/new.md")).toBe(true);
		expect(store.getChat(3)?.path).toBe("PuzleRead/Chats/new.md");

		expect(store.handleRename("unrelated.md", "other.md")).toBe(false);
		expect(store.handleRename("same.md", "same.md")).toBe(false);
	});
});
