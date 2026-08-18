import { beforeEach, describe, expect, it } from "vitest";
import type { ReadingItem } from "../../src/core/models";
import { DEFAULT_SETTINGS, mergePluginData } from "../../src/settings";
import {
	articleBaseName,
	articleFingerprint,
	ArticleSyncer,
	EARLY_STOP_PAGES,
	isSyncableArticle
} from "../../src/sync/article-syncer";
import { createSharedState, type SyncContext, type SyncMode } from "../../src/sync/engine";
import { SyncStore } from "../../src/sync/store";
import { FakeClient, makeComment, makeDetail, makeHighlight, makeItem } from "../helpers/fake-client";
import { FakeSyncGateway } from "../helpers/fake-gateway";

function makeCtx(opts: {
	client: FakeClient;
	gateway: FakeSyncGateway;
	store: SyncStore;
	mode?: SyncMode;
	settings?: Partial<typeof DEFAULT_SETTINGS>;
	notices?: string[];
}): SyncContext {
	return {
		mode: opts.mode ?? "incremental",
		client: opts.client.asClient(),
		vaultGateway: opts.gateway.asGateway(),
		store: opts.store,
		settings: { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) },
		shared: createSharedState(),
		now: "2026-08-10T15:00:00Z",
		notice: (message) => {
			opts.notices?.push(message);
		}
	};
}

describe("articleFingerprint", () => {
	const base = makeItem({
		id: 123,
		status: "done",
		title: "如何阅读一本书",
		highlight_count: 12,
		comment_count: 3,
		last_comment_at: "2026-03-19T09:00:00Z"
	});

	it("is stable for identical inputs", () => {
		expect(articleFingerprint(base)).toBe(articleFingerprint({ ...base }));
		expect(articleFingerprint(base)).toMatch(/^[0-9a-f]{8}$/);
	});

	it.each([
		["status", { status: "viewed" as const }],
		["title", { title: "改名了" }],
		["highlight_count", { highlight_count: 13 }],
		["comment_count", { comment_count: 4 }],
		["last_comment_at", { last_comment_at: "2026-03-20T00:00:00Z" }]
	])("changes when %s changes", (_label, patch) => {
		expect(articleFingerprint({ ...base, ...patch })).not.toBe(articleFingerprint(base));
	});

	it("ignores fields outside the fingerprint tuple", () => {
		expect(articleFingerprint({ ...base, domain: "other.com", puzle_id: 999 })).toBe(
			articleFingerprint(base)
		);
	});
});

describe("isSyncableArticle", () => {
	it("accepts link/file with done/viewed/interacted", () => {
		for (const resource_type of ["link", "file"] as const) {
			for (const status of ["done", "viewed", "interacted"] as const) {
				expect(isSyncableArticle(makeItem({ resource_type, status }))).toBe(true);
			}
		}
	});

	it("rejects chats and unfinished statuses", () => {
		expect(isSyncableArticle(makeItem({ resource_type: "chat" }))).toBe(false);
		for (const status of ["fetching", "parsing", "ai_reading", "fail", "thinking", null] as const) {
			expect(isSyncableArticle(makeItem({ status: status as never }))).toBe(false);
		}
	});
});

describe("ArticleSyncer incremental decisions", () => {
	let client: FakeClient;
	let gateway: FakeSyncGateway;
	let store: SyncStore;
	let flushes: number;
	let notices: string[];

	beforeEach(() => {
		client = new FakeClient();
		gateway = new FakeSyncGateway();
		flushes = 0;
		notices = [];
		const data = mergePluginData(null);
		store = new SyncStore({
			getData: () => data,
			saveData: async () => {
				flushes += 1;
			}
		});
	});

	const seedCached = (item: ReadingItem): void => {
		store.setArticle(item.id, {
			path: `PuzleRead/Articles/${articleBaseName(item)}.md`,
			fingerprint: articleFingerprint(item),
			managedHash: "cached-hash",
			syncedAt: "2026-08-01T00:00:00Z"
		});
	};

	it("skips items whose fingerprint matches the store without fetching details", async () => {
		const item = makeItem({ id: 123 });
		client.pages = [[item]];
		seedCached(item);

		const syncer = new ArticleSyncer();
		const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));

		expect(report).toMatchObject({ key: "articles", skipped: 1, created: 0, updated: 0, failed: 0 });
		expect(client.detailCalls).toEqual([]);
		expect(client.highlightCalls).toEqual([]);
		expect(gateway.writes).toEqual([]);
		expect(flushes).toBeGreaterThan(0);
	});

	it("fetches detail/summary/highlights/comments and writes when the fingerprint differs", async () => {
		const item = makeItem({ id: 123, title: "如何阅读一本书", highlight_count: 1 });
		client.pages = [[item]];
		client.details.set(123, makeDetail(item, { content: "阅读的第一层次是基础阅读。" }));
		client.summaries.set(123, { key_points: ["四个层次"] });
		client.highlights.set(123, [makeHighlight({ id: 456, content: "基础阅读" })]);
		client.comments.set(123, [
			makeComment({ id: 1, highlight_id: null, content: "文章级想法" }),
			makeComment({ id: 2, highlight_id: 456, content: "挂靠高亮的想法" })
		]);

		const syncer = new ArticleSyncer();
		const ctx = makeCtx({ client, gateway, store, notices });
		const report = await syncer.sync(ctx);

		expect(report).toMatchObject({ created: 1, skipped: 0, failed: 0 });
		expect(client.detailCalls).toEqual([123]);
		expect(client.summaryCalls).toEqual([123]);
		expect(client.highlightCalls).toEqual([123]);
		expect(client.commentCalls).toEqual([123]);

		expect(gateway.writes).toHaveLength(1);
		const write = gateway.writes[0];
		expect(write.relative).toBe("Articles/如何阅读一本书 (r123).md");
		expect(write.frontmatter.reading_id).toBe(123);
		expect(write.frontmatter.synced).toBe("2026-08-10T15:00:00Z");
		expect(write.managed).toContain("## 摘要");
		expect(write.managed).toContain("文章级想法");
		expect(write.managed).not.toContain("挂靠高亮的想法");

		const state = store.getArticle(123);
		expect(state?.fingerprint).toBe(articleFingerprint(item));
		expect(state?.path).toBe("PuzleRead/Articles/如何阅读一本书 (r123).md");
		expect(state?.managedHash).toBeTruthy();

		expect(ctx.shared.highlightJobs).toHaveLength(1);
		expect(ctx.shared.highlightJobs[0].highlight.id).toBe(456);
		expect(ctx.shared.highlightJobs[0].comments.map((c) => c.id)).toEqual([2]);
		expect(ctx.shared.remoteHighlightIds.get(123)).toEqual(new Set([456]));
	});

	it("injects anchors into the body when enabled and skips them when disabled", async () => {
		const item = makeItem({ id: 5, title: "锚点", highlight_count: 1 });
		client.pages = [[item]];
		client.details.set(5, makeDetail(item, { content: "这是一段正文。基础阅读很重要。" }));
		client.highlights.set(5, [makeHighlight({ id: 9, content: "基础阅读" })]);

		const syncer = new ArticleSyncer();
		await syncer.sync(makeCtx({ client, gateway, store, notices }));
		expect(gateway.writes[0].managed).toContain("==基础阅读== [[锚点 h9|💬]]");

		gateway.writes.length = 0;
		store.deleteArticle(5);
		await syncer.sync(
			makeCtx({ client, gateway, store, notices, settings: { injectAnchors: false } })
		);
		expect(gateway.writes[0].managed).not.toContain("==基础阅读==");
	});

	it("counts failed items and keeps going", async () => {
		const good = makeItem({ id: 1 });
		const bad = makeItem({ id: 2 });
		client.pages = [[bad, good]];
		client.failDetailFor.add(2);
		client.details.set(1, makeDetail(good));

		const syncer = new ArticleSyncer();
		const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));

		expect(report).toMatchObject({ created: 1, failed: 1 });
		expect(notices.some((n) => n.includes("同步失败"))).toBe(true);
	});

	it("second run skips previously synced unchanged items", async () => {
		const item = makeItem({ id: 7 });
		client.pages = [[item]];
		client.details.set(7, makeDetail(item));

		const syncer = new ArticleSyncer();
		const first = await syncer.sync(makeCtx({ client, gateway, store, notices }));
		expect(first.created).toBe(1);

		const second = await syncer.sync(makeCtx({ client, gateway, store, notices }));
		expect(second).toMatchObject({ skipped: 1, created: 0, updated: 0 });
		expect(client.detailCalls).toEqual([7]);
		expect(gateway.writes).toHaveLength(1);
	});

	it("updates when the fingerprint changed and keeps the stored path", async () => {
		const item = makeItem({ id: 8, title: "旧标题" });
		client.pages = [[item]];
		client.details.set(8, makeDetail(item));
		const syncer = new ArticleSyncer();
		await syncer.sync(makeCtx({ client, gateway, store, notices }));
		store.getArticle(8)!.path = "PuzleRead/Articles/用户改名.md";

		const changed = makeItem({ id: 8, title: "旧标题", comment_count: 5 });
		client.pages = [[changed]];
		const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));

		expect(report.updated).toBe(1);
		expect(gateway.writes.at(-1)!.relative).toBe("Articles/用户改名.md");
		expect(store.getArticle(8)!.path).toBe("PuzleRead/Articles/用户改名.md");
	});

	it("skips writing when the managed region was locally edited and onEditedManaged=skip", async () => {
		const item = makeItem({ id: 11 });
		client.pages = [[item]];
		client.details.set(11, makeDetail(item));
		store.setArticle(11, {
			path: "PuzleRead/Articles/x.md",
			fingerprint: "stale",
			managedHash: "hash-of-user-edited-region",
			syncedAt: "2026-08-01T00:00:00Z"
		});
		gateway.managedByPath.set("PuzleRead/Articles/x.md", "用户改过的 managed 内容");

		const syncer = new ArticleSyncer();
		const report = await syncer.sync(
			makeCtx({ client, gateway, store, notices, settings: { onEditedManaged: "skip" } })
		);

		expect(report.skipped).toBe(1);
		expect(gateway.writes).toEqual([]);
		expect(notices.some((n) => n.includes("本地修改"))).toBe(true);
	});

	it("overwrites a locally edited managed region by default", async () => {
		const item = makeItem({ id: 12 });
		client.pages = [[item]];
		client.details.set(12, makeDetail(item));
		store.setArticle(12, {
			path: "PuzleRead/Articles/y.md",
			fingerprint: "stale",
			managedHash: "old-hash",
			syncedAt: "2026-08-01T00:00:00Z"
		});
		gateway.managedByPath.set("PuzleRead/Articles/y.md", "用户改过的 managed 内容");

		const syncer = new ArticleSyncer();
		const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));
		expect(report.updated).toBe(1);
		expect(gateway.writes).toHaveLength(1);
	});

	describe("incremental early stop", () => {
		const PAGE = 50;

		const buildPages = (count: number, changedId: number | null): ReadingItem[] => {
			const items: ReadingItem[] = [];
			for (let i = 1; i <= count; i++) items.push(makeItem({ id: i, title: `文章 ${i}` }));
			client.pages = [];
			for (let start = 0; start < items.length; start += PAGE) {
				client.pages.push(items.slice(start, start + PAGE));
			}
			for (const item of items) {
				if (item.id === changedId) {
					client.details.set(item.id, makeDetail(item));
					continue;
				}
				seedCached(item);
			}
			return items;
		};

		it("requires EARLY_STOP_PAGES consecutive all-hit pages", () => {
			expect(EARLY_STOP_PAGES).toBe(2);
		});

		it("incremental stops after two consecutive all-hit pages and does no detail work", async () => {
			buildPages(150, 120);

			const syncer = new ArticleSyncer();
			const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));

			expect(report).toMatchObject({ skipped: 100, created: 0, updated: 0, failed: 0 });
			expect(client.detailCalls).toEqual([]);
			expect(client.listCalls).toEqual([1, 2, 3]);
		});

		it("full mode walks every page and re-syncs everything, ignoring fingerprints", async () => {
			const items = buildPages(150, 120);
			for (const item of items) {
				if (!client.details.has(item.id)) client.details.set(item.id, makeDetail(item));
			}

			const syncer = new ArticleSyncer();
			const report = await syncer.sync(
				makeCtx({ client, gateway, store, mode: "full", notices })
			);

			expect(report).toMatchObject({ skipped: 0, created: 1, updated: 149, failed: 0 });
			expect(client.detailCalls).toHaveLength(150);
			expect(client.listCalls).toEqual([1, 2, 3]);
		});

		it("a changed page resets the consecutive-hit counter", async () => {
			buildPages(250, 75);

			const syncer = new ArticleSyncer();
			const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));

			// pages 1..4 processed (page 2 contains the changed item and resets the
			// counter), stop kicks in at the first item of page 5.
			expect(report).toMatchObject({ created: 1, skipped: 199, failed: 0 });
			expect(client.detailCalls).toEqual([75]);
			expect(client.listCalls).toEqual([1, 2, 3, 4, 5]);
		});

		it("pages without syncable articles are neutral for the counter", async () => {
			const chats: ReadingItem[] = [];
			for (let i = 1000; i < 1050; i++) {
				chats.push(makeItem({ id: i, resource_type: "chat", status: "thinking" }));
			}
			client.pages = [chats];
			const syncer = new ArticleSyncer();
			const report = await syncer.sync(makeCtx({ client, gateway, store, notices }));
			expect(report).toMatchObject({ created: 0, skipped: 0, failed: 0 });
			expect(client.detailCalls).toEqual([]);
		});
	});
});
