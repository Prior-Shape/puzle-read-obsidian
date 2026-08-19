import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	DEFAULT_SYNC_STATE,
	cloneDefaultPluginData,
	deepMerge,
	mergePluginData,
	type PluginData,
	type SyncArticleState
} from "../src/settings";

function makeArticleState(id: number): SyncArticleState {
	return {
		path: `PuzleRead/Articles/article-${id}.md`,
		fingerprint: `fp-${id}`,
		managedHash: `hash-${id}`,
		syncedAt: "2026-08-01T00:00:00Z"
	};
}

describe("DEFAULT_SETTINGS", () => {
	it("matches the spec defaults", () => {
		expect(DEFAULT_SETTINGS).toEqual({
			baseUrl: "https://read-web.puzle.com.cn",
			token: "",
			rootFolder: "PuzleRead",
			autoSyncMinutes: 0,
			injectAnchors: true,
			readingMode: true,
			keepThinking: false,
			onEditedManaged: "overwrite",
			plaintextVariant: "raw"
		});
	});

	it("has empty sync state defaults", () => {
		expect(DEFAULT_SYNC_STATE).toEqual({
			lastSyncAt: null,
			articles: {},
			highlights: {},
			chats: {},
			continuationChatId: null
		});
	});
});

describe("mergePluginData", () => {
	it("returns full defaults for undefined / null / non-object input", () => {
		const expected: PluginData = { settings: DEFAULT_SETTINGS, syncState: DEFAULT_SYNC_STATE };
		expect(mergePluginData(undefined)).toEqual(expected);
		expect(mergePluginData(null)).toEqual(expected);
		expect(mergePluginData("garbage")).toEqual(expected);
		expect(mergePluginData(42)).toEqual(expected);
		expect(mergePluginData([])).toEqual(expected);
	});

	it("returns defaults for an empty object", () => {
		const data = mergePluginData({});
		expect(data.settings).toEqual(DEFAULT_SETTINGS);
		expect(data.syncState).toEqual(DEFAULT_SYNC_STATE);
	});

	it("merges partial settings over defaults", () => {
		const data = mergePluginData({ settings: { token: "abc", baseUrl: "https://example.com" } });
		expect(data.settings.token).toBe("abc");
		expect(data.settings.baseUrl).toBe("https://example.com");
		expect(data.settings.rootFolder).toBe(DEFAULT_SETTINGS.rootFolder);
		expect(data.settings.autoSyncMinutes).toBe(0);
		expect(data.settings.injectAnchors).toBe(true);
		expect(data.settings.keepThinking).toBe(false);
		expect(data.settings.onEditedManaged).toBe("overwrite");
		expect(data.syncState).toEqual(DEFAULT_SYNC_STATE);
	});

	it("preserves saved sync state entries", () => {
		const saved = {
			syncState: {
				lastSyncAt: "2026-08-09T12:00:00Z",
				articles: { 123: makeArticleState(123) },
				chats: { 7: { path: "PuzleRead/Chats/chat (c7).md", turnCount: 4, managedHash: "ch-7" } },
				continuationChatId: 42
			}
		};
		const data = mergePluginData(saved);
		expect(data.syncState.lastSyncAt).toBe("2026-08-09T12:00:00Z");
		expect(data.syncState.articles[123]).toEqual(makeArticleState(123));
		expect(data.syncState.chats[7]).toEqual({
			path: "PuzleRead/Chats/chat (c7).md",
			turnCount: 4,
			managedHash: "ch-7"
		});
		expect(data.syncState.continuationChatId).toBe(42);
		expect(data.syncState.highlights).toEqual({});
		expect(data.settings).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps explicit null values from saved data", () => {
		const data = mergePluginData({ syncState: { lastSyncAt: null, continuationChatId: null } });
		expect(data.syncState.lastSyncAt).toBeNull();
		expect(data.syncState.continuationChatId).toBeNull();
	});

	it("merges settings and sync state together", () => {
		const data = mergePluginData({
			settings: { keepThinking: true, autoSyncMinutes: 30 },
			syncState: { highlights: { 5: { path: "PuzleRead/Highlights/h5.md", managedHash: "hh-5" } } }
		});
		expect(data.settings.keepThinking).toBe(true);
		expect(data.settings.autoSyncMinutes).toBe(30);
		expect(data.settings.token).toBe("");
		expect(data.syncState.highlights[5].path).toBe("PuzleRead/Highlights/h5.md");
	});

	it("never aliases the shared default objects", () => {
		const data = mergePluginData({ settings: { token: "x" } });
		expect(data.settings).not.toBe(DEFAULT_SETTINGS);
		expect(data.syncState).not.toBe(DEFAULT_SYNC_STATE);
		expect(data.syncState.articles).not.toBe(DEFAULT_SYNC_STATE.articles);
		expect(data.syncState.highlights).not.toBe(DEFAULT_SYNC_STATE.highlights);
		expect(data.syncState.chats).not.toBe(DEFAULT_SYNC_STATE.chats);

		data.syncState.articles[999] = makeArticleState(999);
		data.settings.rootFolder = "Mutated";
		expect(DEFAULT_SYNC_STATE.articles).toEqual({});
		expect(DEFAULT_SETTINGS.rootFolder).toBe("PuzleRead");
	});

	it("cloneDefaultPluginData returns independent copies", () => {
		const a = cloneDefaultPluginData();
		const b = cloneDefaultPluginData();
		a.syncState.articles[1] = makeArticleState(1);
		a.settings.token = "a-token";
		expect(b.syncState.articles).toEqual({});
		expect(b.settings.token).toBe("");
	});
});

describe("deepMerge", () => {
	it("returns a copy of base when patch is not a plain object", () => {
		const base = { a: 1, nested: { b: 2 } };
		const merged = deepMerge(base, undefined);
		expect(merged).toEqual(base);
		expect(merged).not.toBe(base);
		expect(deepMerge(base, null)).toEqual(base);
		expect(deepMerge(base, "x")).toEqual(base);
	});

	it("recursively merges nested plain objects", () => {
		const merged = deepMerge({ a: { b: 1, c: 2 }, d: 3 }, { a: { c: 20, e: 5 } });
		expect(merged).toEqual({ a: { b: 1, c: 20, e: 5 }, d: 3 });
	});

	it("replaces scalars, arrays and nulls wholesale", () => {
		const merged = deepMerge(
			{ list: [1, 2], flag: true, maybe: null as number | null },
			{ list: [3], flag: false, maybe: 7 }
		);
		expect(merged.list).toEqual([3]);
		expect(merged.flag).toBe(false);
		expect(merged.maybe).toBe(7);
	});

	it("skips undefined patch values", () => {
		const merged = deepMerge({ a: 1 }, { a: undefined });
		expect(merged.a).toBe(1);
	});
});
