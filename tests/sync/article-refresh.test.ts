import { beforeEach, describe, expect, it } from "vitest";
import type { FileReadingDetail, LinkReadingDetail } from "../../src/core/models";
import { DEFAULT_SETTINGS, mergePluginData } from "../../src/settings";
import type { Settings } from "../../src/settings";
import { ArticleRefresher } from "../../src/sync/article-refresh";
import { SyncStore } from "../../src/sync/store";
import { FakeClient, makeComment, makeDetail, makeHighlight, makeItem } from "../helpers/fake-client";
import { FakeSyncGateway } from "../helpers/fake-gateway";

const READING_ID = 101;

/** FakeClient 的 link/file 详情走同一份 fixture，这里分开计数才能看出走了哪个接口 */
class RefreshClient extends FakeClient {
	linkCalls: number[] = [];
	fileCalls: number[] = [];
	linkFails = new Set<number>();

	async getLinkDetail(readingId: number): Promise<LinkReadingDetail> {
		this.linkCalls.push(readingId);
		if (this.linkFails.has(readingId)) throw new Error("not a link");
		return super.getLinkDetail(readingId);
	}

	async getFileDetail(readingId: number): Promise<FileReadingDetail> {
		this.fileCalls.push(readingId);
		return super.getFileDetail(readingId);
	}
}

describe("ArticleRefresher", () => {
	let client: RefreshClient;
	let gateway: FakeSyncGateway;
	let store: SyncStore;
	let notices: string[];
	let settings: Settings;

	const makeRefresher = (): ArticleRefresher =>
		new ArticleRefresher({
			getClient: () => client.asClient(),
			getGateway: () => gateway.asGateway(),
			getSettings: () => settings,
			store,
			notice: (message) => notices.push(message)
		});

	const seedRemote = (): void => {
		const item = makeItem({ id: READING_ID, title: "如何阅读一本书" });
		client.details.set(READING_ID, makeDetail(item, { content: "基础阅读是第一层。" }));
		client.highlights.set(READING_ID, [
			makeHighlight({ id: 9, content: "基础阅读", location_data: { start_index: 0, end_index: 4 } })
		]);
		client.comments.set(READING_ID, [
			makeComment({ id: 3, content: "这个分层框架很实用", highlight_id: null }),
			makeComment({ id: 4, content: "挂在高亮下的想法", highlight_id: 9 })
		]);
	};

	beforeEach(() => {
		client = new RefreshClient();
		gateway = new FakeSyncGateway();
		notices = [];
		settings = { ...DEFAULT_SETTINGS };
		const data = mergePluginData(null);
		store = new SyncStore({ getData: () => data, saveData: async () => undefined });
		seedRemote();
	});

	it("重建文章笔记：正文注入锚点、写出高亮笔记、记账口径与同步一致", async () => {
		expect(await makeRefresher().refresh(READING_ID)).toBe(true);

		const article = gateway.writes.find((w) => w.relative.startsWith("Articles/"));
		const highlight = gateway.writes.find((w) => w.relative.startsWith("Highlights/"));
		expect(article?.relative).toBe("Articles/如何阅读一本书 (r101).md");
		expect(article?.managed).toContain("==基础阅读== [[如何阅读一本书 h9|💬]]");
		expect(article?.managed).toContain("这个分层框架很实用");
		expect(highlight?.relative).toBe("Highlights/如何阅读一本书 h9.md");

		const stored = store.getArticle(READING_ID);
		expect(stored?.path).toBe("PuzleRead/Articles/如何阅读一本书 (r101).md");
		expect(stored?.managedHash).toBeTruthy();
		// 记下来源类型，下次刷新不用再探测
		expect(stored?.resourceType).toBe("link");
		expect(store.getHighlight(9)?.readingId).toBe(READING_ID);
	});

	it("只请求这一篇：detail / summary / highlights / comments 各一次", async () => {
		await makeRefresher().refresh(READING_ID);

		expect(client.linkCalls).toEqual([READING_ID]);
		expect(client.summaryCalls).toEqual([READING_ID]);
		expect(client.highlightCalls).toEqual([READING_ID]);
		expect(client.commentCalls).toEqual([READING_ID]);
		expect(client.listCalls).toEqual([]);
	});

	it("已知是 file 的文章直接走 file 详情，不再探测 link", async () => {
		store.setArticle(READING_ID, {
			path: "PuzleRead/Articles/旧.md",
			fingerprint: "fp",
			managedHash: "mh",
			syncedAt: "2026-08-10T15:00:00Z",
			resourceType: "file"
		});

		await makeRefresher().refresh(READING_ID);

		expect(client.linkCalls).toEqual([]);
		expect(client.fileCalls).toEqual([READING_ID]);
		// 沿用已记录的路径，用户重命名过的笔记不会被写成新文件
		expect(gateway.writes[0].relative).toBe("Articles/旧.md");
	});

	it("老数据没记 resourceType：link 打不开就退回 file", async () => {
		client.linkFails.add(READING_ID);

		expect(await makeRefresher().refresh(READING_ID)).toBe(true);

		expect(client.linkCalls).toEqual([READING_ID]);
		expect(client.fileCalls).toEqual([READING_ID]);
		expect(store.getArticle(READING_ID)?.resourceType).toBe("link");
	});

	it("拉不到数据时提示一次并返回 false，调用方不会炸", async () => {
		client.details.delete(READING_ID);

		expect(await makeRefresher().refresh(READING_ID)).toBe(false);

		expect(gateway.writes).toEqual([]);
		expect(notices.some((n) => n.includes("笔记刷新失败"))).toBe(true);
	});

	it("managed 区被本地改过且 onEditedManaged=skip 时不覆盖", async () => {
		settings = { ...DEFAULT_SETTINGS, onEditedManaged: "skip" };
		const refresher = makeRefresher();
		await refresher.refresh(READING_ID);
		const path = store.getArticle(READING_ID)!.path;
		gateway.managedByPath.set(path, "用户改过的 managed 内容");

		await refresher.refresh(READING_ID);

		expect(gateway.writes.filter((w) => w.relative.startsWith("Articles/"))).toHaveLength(1);
		expect(notices.some((n) => n.includes("本地修改"))).toBe(true);
	});

	it("连续刷新串行执行，不会两次写同一个文件打架", async () => {
		const refresher = makeRefresher();

		await Promise.all([refresher.refresh(READING_ID), refresher.refresh(READING_ID)]);

		expect(client.linkCalls).toEqual([READING_ID, READING_ID]);
		expect(gateway.writes.filter((w) => w.relative.startsWith("Articles/"))).toHaveLength(2);
	});
});
