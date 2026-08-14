import { describe, expect, it } from "vitest";
import { AuthError } from "../../src/core/api/client";
import { DEFAULT_SETTINGS, mergePluginData } from "../../src/settings";
import {
	createReport,
	summarizeReports,
	SyncEngine,
	type SyncContext,
	type Syncer,
	type SyncReport
} from "../../src/sync/engine";
import { SyncStore } from "../../src/sync/store";
import { FakeClient } from "../helpers/fake-client";
import { FakeSyncGateway } from "../helpers/fake-gateway";

function makeEngine(opts?: {
	syncers?: Syncer[];
	notice?: (message: string) => void;
}): {
	engine: SyncEngine;
	gateway: FakeSyncGateway;
	store: SyncStore;
	notices: string[];
	flushes: () => number;
} {
	const gateway = new FakeSyncGateway();
	const data = mergePluginData(null);
	let flushes = 0;
	const store = new SyncStore({
		getData: () => data,
		saveData: async () => {
			flushes += 1;
		}
	});
	const notices: string[] = [];
	const client = new FakeClient();
	const engine = new SyncEngine({
		getClient: () => client.asClient(),
		getGateway: () => gateway.asGateway(),
		getSettings: () => ({ ...DEFAULT_SETTINGS }),
		store,
		notice: opts?.notice ?? ((message) => notices.push(message))
	});
	for (const syncer of opts?.syncers ?? []) engine.register(syncer);
	return { engine, gateway, store, notices, flushes: () => flushes };
}

function fakeSyncer(key: string, patch: Partial<SyncReport> = {}, hook?: (ctx: SyncContext) => Promise<void>): Syncer {
	return {
		key,
		async sync(ctx) {
			await hook?.(ctx);
			return { ...createReport(key), ...patch };
		}
	};
}

describe("SyncEngine", () => {
	it("scaffolds the workspace before running syncers", async () => {
		const { engine, gateway } = makeEngine();
		await engine.runSync("full");
		expect(gateway.ensuredFolders).toContain("PuzleRead/Articles");
		expect(gateway.createdFiles.map((f) => f.path)).toEqual(
			expect.arrayContaining([
				"PuzleRead/Articles.base",
				"PuzleRead/Highlights.base",
				"PuzleRead/README.md"
			])
		);
	});

	it("runs syncers in registration order and aggregates the summary", async () => {
		const order: string[] = [];
		const { engine, notices } = makeEngine({
			syncers: [
				fakeSyncer("articles", { created: 2, skipped: 3 }, async () => {
					order.push("articles");
				}),
				fakeSyncer("highlights", { created: 5, deleted: 1 }, async () => {
					order.push("highlights");
				})
			]
		});

		const reports = await engine.runSync("full");

		expect(order).toEqual(["articles", "highlights"]);
		expect(reports).toHaveLength(2);
		const summary = notices.at(-1)!;
		expect(summary).toContain("全量同步完成");
		expect(summary).toContain("7 新增");
		expect(summary).toContain("3 跳过");
		expect(summary).toContain("1 删除");
	});

	it("sets lastSyncAt and flushes after each syncer", async () => {
		const { engine, store, flushes } = makeEngine({
			syncers: [fakeSyncer("articles", { created: 1 })]
		});
		expect(store.lastSyncAt).toBeNull();
		await engine.runSync("incremental");
		expect(store.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect(flushes()).toBeGreaterThanOrEqual(2);
	});

	it("guards against concurrent runs", async () => {
		let release: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { engine, notices } = makeEngine({
			syncers: [
				fakeSyncer("articles", {}, async () => {
					await blocked;
				})
			]
		});

		const first = engine.runSync("full");
		expect(engine.isSyncing).toBe(true);
		const second = await engine.runSync("full");
		expect(second).toEqual([]);
		expect(notices.some((n) => n.includes("正在同步中"))).toBe(true);

		release();
		const firstReports = await first;
		expect(firstReports).toHaveLength(1);
		expect(engine.isSyncing).toBe(false);
	});

	it("reports auth failures via notice and still flushes state", async () => {
		const { engine, notices, flushes } = makeEngine({
			syncers: [
				{
					key: "articles",
					async sync() {
						throw new AuthError();
					}
				}
			]
		});
		const reports = await engine.runSync("full");
		expect(reports).toEqual([]);
		expect(notices.some((n) => n.includes("Token 已失效"))).toBe(true);
		expect(flushes()).toBeGreaterThanOrEqual(1);
		expect(engine.isSyncing).toBe(false);
	});

	it("reports generic failures via notice", async () => {
		const { engine, notices } = makeEngine({
			syncers: [
				{
					key: "articles",
					async sync() {
						throw new Error("boom");
					}
				}
			]
		});
		await engine.runSync("incremental");
		expect(notices.some((n) => n.includes("同步失败") && n.includes("boom"))).toBe(true);
	});
});

describe("summarizeReports", () => {
	it("omits zero deleted/failed counters", () => {
		const summary = summarizeReports("incremental", [
			{ key: "a", created: 1, updated: 2, skipped: 3, deleted: 0, failed: 0 }
		]);
		expect(summary).toBe("Puzle Read：增量同步完成，1 新增，2 更新，3 跳过");
	});
});
