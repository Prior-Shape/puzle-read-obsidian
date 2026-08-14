import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergePluginData } from "../../src/settings";
import { ArticleSyncer } from "../../src/sync/article-syncer";
import { createSharedState, type SyncContext } from "../../src/sync/engine";
import { HighlightSyncer } from "../../src/sync/highlight-syncer";
import { SyncStore } from "../../src/sync/store";
import { FakeClient, makeComment, makeDetail, makeHighlight, makeItem } from "../helpers/fake-client";
import { FakeSyncGateway } from "../helpers/fake-gateway";

describe("HighlightSyncer", () => {
	let client: FakeClient;
	let gateway: FakeSyncGateway;
	let store: SyncStore;
	let notices: string[];

	beforeEach(() => {
		client = new FakeClient();
		gateway = new FakeSyncGateway();
		notices = [];
		const data = mergePluginData(null);
		store = new SyncStore({ getData: () => data, saveData: async () => undefined });
	});

	async function runArticleSyncer(ctx: SyncContext): Promise<void> {
		await new ArticleSyncer().sync(ctx);
	}

	function makeCtx(shared = createSharedState()): SyncContext {
		return {
			mode: "incremental",
			client: client.asClient(),
			vaultGateway: gateway.asGateway(),
			store,
			settings: { ...DEFAULT_SETTINGS },
			shared,
			now: "2026-08-10T15:00:00Z",
			notice: (message) => {
				notices.push(message);
			}
		};
	}

	it("writes one file per highlight using the shared article batch (no extra requests)", async () => {
		const item = makeItem({ id: 123, title: "如何阅读一本书", highlight_count: 2 });
		client.pages = [[item]];
		client.details.set(123, makeDetail(item));
		client.highlights.set(123, [
			makeHighlight({ id: 456, content: "第一处高亮" }),
			makeHighlight({ id: 789, content: "第二处高亮", role: "assistant" })
		]);
		client.comments.set(123, [
			makeComment({ id: 1, highlight_id: 456, content: "想法甲" }),
			makeComment({ id: 2, highlight_id: 456, content: "想法乙", role: "assistant" }),
			makeComment({ id: 3, highlight_id: null, content: "文章级想法" })
		]);

		const ctx = makeCtx();
		await runArticleSyncer(ctx);
		const listCallsAfterArticles = client.listCalls.length;
		const detailCallsAfterArticles = client.detailCalls.length;

		const report = await new HighlightSyncer().sync(ctx);

		expect(report).toMatchObject({ key: "highlights", created: 2, failed: 0 });
		expect(client.listCalls).toHaveLength(listCallsAfterArticles);
		expect(client.detailCalls).toHaveLength(detailCallsAfterArticles);

		const first = gateway.writes.find((w) => w.relative === "Highlights/如何阅读一本书 h456.md");
		expect(first).toBeDefined();
		expect(first!.frontmatter).toMatchObject({
			puzle_type: "highlight",
			highlight_id: 456,
			reading_id: 123,
			article: "[[如何阅读一本书 (r123)]]",
			category: "key_points",
			role: "user"
		});
		expect(first!.managed).toContain("> 第一处高亮");
		expect(first!.managed).toContain("想法甲");
		expect(first!.managed).toContain("想法乙");
		expect(first!.managed).not.toContain("文章级想法");

		expect(store.getHighlight(456)?.readingId).toBe(123);
		expect(store.getHighlight(789)?.path).toBe("PuzleRead/Highlights/如何阅读一本书 h789.md");
	});

	it("updates existing highlight entries instead of creating", async () => {
		const item = makeItem({ id: 1, highlight_count: 1 });
		client.pages = [[item]];
		client.details.set(1, makeDetail(item));
		client.highlights.set(1, [makeHighlight({ id: 10 })]);

		const ctx = makeCtx();
		await runArticleSyncer(ctx);
		expect(await new HighlightSyncer().sync(ctx)).toMatchObject({ created: 1 });

		// second run with a changed article fingerprint
		const changed = makeItem({ id: 1, highlight_count: 1, comment_count: 1 });
		client.pages = [[changed]];
		const ctx2 = makeCtx();
		await runArticleSyncer(ctx2);
		expect(await new HighlightSyncer().sync(ctx2)).toMatchObject({ updated: 1, created: 0 });
	});

	it("trashes remotely deleted highlights and clears their store mapping", async () => {
		store.setHighlight(999, {
			path: "PuzleRead/Highlights/旧文章 h999.md",
			managedHash: "abc",
			readingId: 123
		});
		gateway.files.add("PuzleRead/Highlights/旧文章 h999.md");

		const item = makeItem({ id: 123, highlight_count: 1 });
		client.pages = [[item]];
		client.details.set(123, makeDetail(item));
		client.highlights.set(123, [makeHighlight({ id: 456 })]);

		const ctx = makeCtx();
		await runArticleSyncer(ctx);
		const report = await new HighlightSyncer().sync(ctx);

		expect(report).toMatchObject({ created: 1, deleted: 1 });
		expect(gateway.trashed).toEqual(["PuzleRead/Highlights/旧文章 h999.md"]);
		expect(store.getHighlight(999)).toBeUndefined();
		expect(store.getHighlight(456)).toBeDefined();
	});

	it("keeps highlights of articles that were not re-synced this run", async () => {
		store.setHighlight(555, {
			path: "PuzleRead/Highlights/未变更文章 h555.md",
			managedHash: "abc",
			readingId: 999
		});
		gateway.files.add("PuzleRead/Highlights/未变更文章 h555.md");

		const ctx = makeCtx();
		const report = await new HighlightSyncer().sync(ctx);

		expect(report.deleted).toBe(0);
		expect(gateway.trashed).toEqual([]);
		expect(store.getHighlight(555)).toBeDefined();
	});

	it("skips writing when managed region was locally edited and onEditedManaged=skip", async () => {
		store.setHighlight(42, {
			path: "PuzleRead/Highlights/文章 h42.md",
			managedHash: "stored-hash",
			readingId: 1
		});
		gateway.files.add("PuzleRead/Highlights/文章 h42.md");
		gateway.managedByPath.set("PuzleRead/Highlights/文章 h42.md", "用户改过的内容");

		const item = makeItem({ id: 1, highlight_count: 1 });
		client.pages = [[item]];
		client.details.set(1, makeDetail(item));
		client.highlights.set(1, [makeHighlight({ id: 42 })]);

		const ctx = makeCtx();
		ctx.settings = { ...DEFAULT_SETTINGS, onEditedManaged: "skip" };
		await runArticleSyncer(ctx);
		const writesAfterArticles = gateway.writes.length;
		const report = await new HighlightSyncer().sync(ctx);

		expect(report.skipped).toBe(1);
		expect(gateway.writes).toHaveLength(writesAfterArticles);
		expect(notices.some((n) => n.includes("本地修改"))).toBe(true);
	});
});
