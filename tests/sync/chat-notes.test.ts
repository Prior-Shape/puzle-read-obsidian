import { beforeEach, describe, expect, it } from "vitest";
import { watchChatNotes } from "../../src/chat/feature";
import type { ChatControllerState } from "../../src/chat/controller";
import type { ChatMessage } from "../../src/core/ws/history";
import { DEFAULT_SETTINGS, mergePluginData } from "../../src/settings";
import type { Settings } from "../../src/settings";
import { ChatNotes, countTurns } from "../../src/sync/chat-notes";
import { SyncStore } from "../../src/sync/store";
import { FakeSyncGateway } from "../helpers/fake-gateway";

const MESSAGES: ChatMessage[] = [
	{ id: "user-t1", role: "user", content: "阅读的四个层次是什么？", turnId: "t1" },
	{ id: "assistant-t1", role: "assistant", content: "基础、检视、分析、主题。", turnId: "t1" }
];

describe("countTurns", () => {
	it("counts one turn per turn_id", () => {
		expect(countTurns(MESSAGES)).toBe(1);
		expect(
			countTurns([
				...MESSAGES,
				{ id: "user-t2", role: "user", content: "展开讲讲", turnId: "t2" },
				{ id: "assistant-t2", role: "assistant", content: "……", turnId: "t2" }
			])
		).toBe(2);
	});

	it("counts a locally sent user message that has no turn_id yet", () => {
		expect(countTurns([...MESSAGES, { id: "user-local", role: "user", content: "在？", turnId: "" }])).toBe(2);
	});

	it("never over-counts: an assistant reply without turn_id belongs to a counted turn", () => {
		// 多算会让增量同步误判「回合数没变」而漏掉这条会话，所以只认 turn_id
		expect(countTurns([{ id: "streaming-x", role: "assistant", content: "…", turnId: "" }])).toBe(0);
	});
});

describe("ChatNotes.write", () => {
	let gateway: FakeSyncGateway;
	let store: SyncStore;
	let notices: string[];
	let settings: Settings;
	let flushes: number;

	const makeNotes = (): ChatNotes =>
		new ChatNotes({
			getGateway: () => gateway.asGateway(),
			getSettings: () => settings,
			store,
			notice: (message) => notices.push(message)
		});

	beforeEach(() => {
		gateway = new FakeSyncGateway();
		notices = [];
		flushes = 0;
		settings = { ...DEFAULT_SETTINGS };
		const data = mergePluginData(null);
		store = new SyncStore({
			getData: () => data,
			saveData: async () => {
				flushes += 1;
			}
		});
	});

	it("writes Chats/{title} (c{id}).md and records path/turnCount/managedHash", async () => {
		const path = await makeNotes().write({ chatId: 214, title: "关于阅读层次的讨论", messages: MESSAGES });

		expect(path).toBe("PuzleRead/Chats/关于阅读层次的讨论 (c214).md");
		expect(gateway.writes).toHaveLength(1);
		expect(gateway.writes[0].relative).toBe("Chats/关于阅读层次的讨论 (c214).md");
		expect(gateway.writes[0].managed).toContain("> 阅读的四个层次是什么？");
		expect(store.getChat(214)).toMatchObject({ path, turnCount: 1 });
		expect(store.getChat(214)?.managedHash).toBeTruthy();
		expect(flushes).toBe(1);
	});

	it("only patches the frontmatter keys it actually knows, so 同步写入的 puzle_id/created 不被抹掉", async () => {
		await makeNotes().write({ chatId: 214, title: null, messages: MESSAGES });

		expect(Object.keys(gateway.writes[0].frontmatter)).toEqual([
			"puzle_type",
			"chat_id",
			"title",
			"synced"
		]);
		expect(gateway.writes[0].frontmatter.title).toBe("对话 214");
	});

	it("keeps writing to the stored path after the user renamed the note", async () => {
		store.setChat(214, { path: "PuzleRead/Chats/我改的名字.md", turnCount: 1, managedHash: "" });

		await makeNotes().write({ chatId: 214, title: "关于阅读层次的讨论", messages: MESSAGES });

		expect(gateway.writes[0].relative).toBe("Chats/我改的名字.md");
		expect(store.getChat(214)?.path).toBe("PuzleRead/Chats/我改的名字.md");
	});

	it("keeps the managed hash in sync so the next incremental sync doesn't cry 本地修改", async () => {
		const notes = makeNotes();
		await notes.write({ chatId: 214, title: "T", messages: MESSAGES });
		const stored = store.getChat(214)!;

		expect(await gateway.readManagedHash("Chats/T (c214).md")).toBe(stored.managedHash);
	});

	it("stops updating a note whose managed region was edited locally (onEditedManaged=skip)", async () => {
		settings = { ...DEFAULT_SETTINGS, onEditedManaged: "skip" };
		const notes = makeNotes();
		await notes.write({ chatId: 214, title: "T", messages: MESSAGES });
		gateway.managedByPath.set("PuzleRead/Chats/T (c214).md", "用户改过的 managed 内容");

		await notes.write({ chatId: 214, title: "T", messages: MESSAGES });
		await notes.write({ chatId: 214, title: "T", messages: MESSAGES });

		expect(gateway.writes).toHaveLength(1);
		expect(notices.filter((n) => n.includes("本地修改"))).toHaveLength(1);
	});

	it("overwrites a locally edited note when onEditedManaged=overwrite（默认）", async () => {
		const notes = makeNotes();
		await notes.write({ chatId: 214, title: "T", messages: MESSAGES });
		gateway.managedByPath.set("PuzleRead/Chats/T (c214).md", "用户改过的 managed 内容");

		await notes.write({ chatId: 214, title: "T", messages: MESSAGES });

		expect(gateway.writes).toHaveLength(2);
	});

	it("surfaces a write failure without throwing at the caller", async () => {
		gateway.writeShouldFail = true;

		await expect(
			makeNotes().write({ chatId: 214, title: "T", messages: MESSAGES })
		).resolves.toBeNull();
		expect(notices.some((n) => n.includes("写回笔记失败"))).toBe(true);
		expect(store.getChat(214)).toBeUndefined();
	});

	it("serializes concurrent writes so the last state wins", async () => {
		const notes = makeNotes();
		const longer = [...MESSAGES, { id: "user-t2", role: "user" as const, content: "再来", turnId: "t2" }];

		await Promise.all([
			notes.write({ chatId: 214, title: "T", messages: MESSAGES }),
			notes.write({ chatId: 214, title: "T", messages: longer })
		]);

		expect(gateway.writes.map((w) => w.relative)).toEqual(["Chats/T (c214).md", "Chats/T (c214).md"]);
		expect(store.getChat(214)?.turnCount).toBe(2);
	});

	it("tracks the streaming chat so the syncer can skip it", () => {
		const notes = makeNotes();
		expect(notes.isBusy(214)).toBe(false);
		notes.setBusy(214);
		expect(notes.isBusy(214)).toBe(true);
		expect(notes.isBusy(215)).toBe(false);
		notes.setBusy(null);
		expect(notes.isBusy(214)).toBe(false);
	});
});

describe("watchChatNotes", () => {
	function makeState(patch: Partial<ChatControllerState["active"]>): ChatControllerState {
		return {
			sessions: [],
			sessionsLoading: false,
			active: {
				chatId: 214,
				title: "T",
				article: null,
				pendingSelection: null,
				messages: MESSAGES,
				streaming: false,
				loading: false,
				error: null,
				...patch
			}
		};
	}

	function makeSpy() {
		const writes: Array<{ chatId: number }> = [];
		const busy: Array<number | null> = [];
		const notes = {
			write: async (input: { chatId: number }) => {
				writes.push(input);
				return null;
			},
			setBusy: (chatId: number | null) => busy.push(chatId),
			isBusy: () => false,
			pathOf: () => null
		} as unknown as ChatNotes;
		return { notes, writes, busy };
	}

	it("writes once when a turn finishes, not while streaming", () => {
		const { notes, writes, busy } = makeSpy();
		const listen = watchChatNotes(notes);

		listen(makeState({ streaming: false, messages: [] }));
		listen(makeState({ streaming: true }));
		listen(makeState({ streaming: true }));
		expect(writes).toHaveLength(0);

		listen(makeState({ streaming: false }));
		expect(writes).toEqual([{ chatId: 214, title: "T", messages: MESSAGES }]);
		expect(busy).toEqual([null, 214, 214, null]);
	});

	it("does not write for a session that never got a chat_id", () => {
		const { notes, writes } = makeSpy();
		const listen = watchChatNotes(notes);

		listen(makeState({ streaming: true, chatId: null }));
		listen(makeState({ streaming: false, chatId: null }));

		expect(writes).toEqual([]);
	});

	it("writes the interrupted turn too（断线后仍留档）", () => {
		const { notes, writes } = makeSpy();
		const listen = watchChatNotes(notes);

		listen(makeState({ streaming: true }));
		listen(makeState({ streaming: false, error: "连接已断开，本次回复中断，请重试" }));

		expect(writes).toHaveLength(1);
	});
});
