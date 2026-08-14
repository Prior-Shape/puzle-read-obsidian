import { beforeEach, describe, expect, it } from "vitest";
import type { ReadingItem } from "../../src/core/models";
import { HISTORY_PAGE_LIMIT } from "../../src/core/ws/manager";
import { DEFAULT_SETTINGS, mergePluginData } from "../../src/settings";
import { chatBaseName, ChatSyncer, resolveTurnTotal } from "../../src/sync/chat-syncer";
import { createSharedState, type SyncContext, type SyncMode } from "../../src/sync/engine";
import { SyncStore } from "../../src/sync/store";
import { makeItem } from "../helpers/fake-client";
import { FakeSyncGateway } from "../helpers/fake-gateway";
import {
	FakeChatSocket,
	makeAssistantEvent,
	makeChatTurn,
	makeHistoryResponse,
	makeLogEvent,
	makeUserEvent
} from "../helpers/fake-socket";
import { FakeClient } from "../helpers/fake-client";

function makeChatItem(overrides: Partial<ReadingItem> = {}): ReadingItem {
	return makeItem({
		id: 501,
		resource_type: "chat",
		chat_id: 214,
		puzle_id: 1727,
		title: "关于阅读层次的讨论",
		status: "done",
		...overrides
	});
}

function makeCtx(opts: {
	client: FakeClient;
	socket: FakeChatSocket;
	gateway: FakeSyncGateway;
	store: SyncStore;
	mode?: SyncMode;
	settings?: Partial<typeof DEFAULT_SETTINGS>;
	notices?: string[];
	signal?: AbortSignal;
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
		},
		signal: opts.signal
	};
}

const TWO_TURNS = [
	makeChatTurn("t1", [makeUserEvent("阅读的四个层次是什么？"), makeAssistantEvent("四个层次：基础、检视、分析、主题。")]),
	makeChatTurn("t2", [makeUserEvent("展开讲讲？"), makeAssistantEvent("检视阅读是在有限时间内抓住全书骨架。")])
];

describe("chatBaseName / resolveTurnTotal", () => {
	it("builds the spec file name and sanitizes the title", () => {
		expect(chatBaseName("关于阅读层次的讨论", 214)).toBe("关于阅读层次的讨论 (c214)");
		expect(chatBaseName('a/b*c?"d', 7)).toBe("abcd (c7)");
	});

	it("prefers response.total and falls back to turns when complete", () => {
		expect(resolveTurnTotal(makeHistoryResponse({ total: 5, turns: TWO_TURNS }))).toBe(5);
		expect(resolveTurnTotal(makeHistoryResponse({ total: undefined, turns: TWO_TURNS }))).toBe(2);
		expect(resolveTurnTotal(makeHistoryResponse({ total: undefined, has_more: true, turns: TWO_TURNS }))).toBeNull();
	});
});

describe("ChatSyncer decisions", () => {
	let client: FakeClient;
	let socket: FakeChatSocket;
	let gateway: FakeSyncGateway;
	let store: SyncStore;
	let notices: string[];

	beforeEach(() => {
		client = new FakeClient();
		socket = new FakeChatSocket();
		gateway = new FakeSyncGateway();
		notices = [];
		const data = mergePluginData(null);
		store = new SyncStore({ getData: () => data, saveData: async () => undefined });
	});

	const seedChat = (chatId: number, turnCount: number): void => {
		store.setChat(chatId, {
			path: `PuzleRead/Chats/${chatBaseName("关于阅读层次的讨论", chatId)}.md`,
			turnCount,
			managedHash: "cached-hash"
		});
	};

	it("skips chats still generating (status=thinking) without touching the socket", async () => {
		client.pages = [[makeChatItem({ status: "thinking" })]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ key: "chats", skipped: 1, created: 0, updated: 0, failed: 0 });
		expect(socket.historyCalls).toEqual([]);
		expect(socket.fullHistoryCalls).toEqual([]);
		expect(gateway.writes).toEqual([]);
	});

	it("skips the continuation chat used by AI 续写", async () => {
		store.setContinuationChatId(214);
		client.pages = [[makeChatItem()]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ skipped: 1, created: 0, failed: 0 });
		expect(socket.historyCalls).toEqual([]);
		expect(socket.fullHistoryCalls).toEqual([]);
		expect(gateway.writes).toEqual([]);
	});

	it("skips when the turn count fingerprint matches the store", async () => {
		seedChat(214, 2);
		socket.firstPages.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS.slice(0, 1) }));
		socket.fullHistories.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS }));
		client.pages = [[makeChatItem()]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ skipped: 1, created: 0, updated: 0, failed: 0 });
		expect(socket.historyCalls).toEqual([{ chatId: 214, offset: 0, limit: HISTORY_PAGE_LIMIT }]);
		expect(socket.fullHistoryCalls).toEqual([]);
		expect(gateway.writes).toEqual([]);
	});

	it("ignores non-chat items entirely", async () => {
		client.pages = [[makeItem({ id: 1, resource_type: "link" })]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ skipped: 0, created: 0, updated: 0, failed: 0 });
		expect(socket.historyCalls).toEqual([]);
	});

	it("fetches the full history, renders and writes Chats/{title} (c{id}).md", async () => {
		socket.firstPages.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS.slice(0, 1) }));
		socket.fullHistories.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS }));
		client.pages = [[makeChatItem()]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ created: 1, skipped: 0, failed: 0 });
		expect(socket.fullHistoryCalls).toEqual([214]);
		expect(gateway.writes).toHaveLength(1);
		const write = gateway.writes[0];
		expect(write.relative).toBe("Chats/关于阅读层次的讨论 (c214).md");
		expect(write.frontmatter).toMatchObject({
			puzle_type: "chat",
			chat_id: 214,
			puzle_id: 1727,
			title: "关于阅读层次的讨论",
			created: "2026-03-18T14:46:40Z",
			synced: "2026-08-10T15:00:00Z"
		});
		expect(write.managed).toContain("## 对话");
		expect(write.managed).toContain("> 阅读的四个层次是什么？");
		expect(write.managed).toContain("四个层次：基础、检视、分析、主题。");
		expect(write.managed).not.toContain("[!note]");

		const state = store.getChat(214);
		expect(state?.turnCount).toBe(2);
		expect(state?.path).toBe("PuzleRead/Chats/关于阅读层次的讨论 (c214).md");
		expect(state?.managedHash).toBeTruthy();
	});

	it("renders thinking logs as a callout when keepThinking is enabled", async () => {
		const turns = [
			makeChatTurn("t1", [
				makeUserEvent("你好"),
				makeLogEvent({ type: "thinking", reasoning: "打招呼即可", marker: "full" }),
				makeAssistantEvent("你好！")
			])
		];
		socket.firstPages.set(214, makeHistoryResponse({ total: 1, turns }));
		socket.fullHistories.set(214, makeHistoryResponse({ total: 1, turns }));
		client.pages = [[makeChatItem()]];

		await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices, settings: { keepThinking: true } })
		);

		expect(gateway.writes[0].managed).toContain("> [!note]- 🧠 思考过程");
		expect(gateway.writes[0].managed).toContain("打招呼即可");
	});

	it("updates when the turn count changed and keeps the stored path", async () => {
		seedChat(214, 1);
		store.getChat(214)!.path = "PuzleRead/Chats/用户改名.md";
		socket.firstPages.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS.slice(0, 1) }));
		socket.fullHistories.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS }));
		client.pages = [[makeChatItem()]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ updated: 1, created: 0 });
		expect(gateway.writes.at(-1)!.relative).toBe("Chats/用户改名.md");
		expect(store.getChat(214)!.path).toBe("PuzleRead/Chats/用户改名.md");
		expect(store.getChat(214)!.turnCount).toBe(2);
	});

	it("skips writing when the managed region was locally edited and onEditedManaged=skip", async () => {
		seedChat(214, 1);
		socket.firstPages.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS.slice(0, 1) }));
		socket.fullHistories.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS }));
		gateway.managedByPath.set(store.getChat(214)!.path, "用户改过的 managed 内容");
		client.pages = [[makeChatItem()]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices, settings: { onEditedManaged: "skip" } })
		);

		expect(report.skipped).toBe(1);
		expect(gateway.writes).toEqual([]);
		expect(notices.some((n) => n.includes("本地修改"))).toBe(true);
	});

	it("counts failed chats, notifies and keeps going", async () => {
		const good = makeChatItem({ id: 501, chat_id: 214 });
		const bad = makeChatItem({ id: 502, chat_id: 999, title: "坏掉的会话" });
		client.pages = [[bad, good]];
		socket.firstPages.set(999, makeHistoryResponse({ chat_id: 999, total: 1 }));
		socket.failFullFor.add(999);
		socket.firstPages.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS.slice(0, 1) }));
		socket.fullHistories.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS }));

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ created: 1, failed: 1 });
		expect(notices.some((n) => n.includes("坏掉的会话") && n.includes("同步失败"))).toBe(true);
	});

	it("prefers the history response title over the item title", async () => {
		socket.firstPages.set(214, makeHistoryResponse({ total: 1, turns: TWO_TURNS.slice(0, 1) }));
		socket.fullHistories.set(
			214,
			makeHistoryResponse({ total: 1, title: "自动生成的标题", turns: TWO_TURNS.slice(0, 1) })
		);
		client.pages = [[makeChatItem()]];

		await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(gateway.writes[0].relative).toBe("Chats/自动生成的标题 (c214).md");
		expect(gateway.writes[0].frontmatter.title).toBe("自动生成的标题");
	});

	it("treats a cancelled full-history fetch as skipped", async () => {
		socket.firstPages.set(214, makeHistoryResponse({ total: 2, turns: TWO_TURNS.slice(0, 1) }));
		socket.cancelFullFor.add(214);
		client.pages = [[makeChatItem()]];

		const report = await new ChatSyncer(() => socket.asSocket()).sync(
			makeCtx({ client, socket, gateway, store, notices })
		);

		expect(report).toMatchObject({ skipped: 1, created: 0, failed: 0 });
		expect(gateway.writes).toEqual([]);
		expect(store.getChat(214)).toBeUndefined();
	});
});
