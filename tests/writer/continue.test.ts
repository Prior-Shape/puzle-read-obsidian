import { describe, expect, it } from "vitest";
import type { SocketFactory, WebSocketLike } from "../../src/core/ports";
import { PuzleSocket } from "../../src/core/ws/manager";
import {
	DEFAULT_CONTINUE_MAX_CHARS,
	ContinueWriter,
	buildContinuePrompt,
	extractContinuePrefix
} from "../../src/writer/continue";
import type { ContinueWriterEditor, ContinuationChatStore } from "../../src/writer/continue";

const WS_URL = "wss://read-web-test.puzle.com.cn/api/v1/agent/events";
const TOKEN = "test-jwt-token";

class FakeSocket implements WebSocketLike {
	static readonly OPEN = 1;
	readyState = 0;
	sent: string[] = [];
	onopen: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data?: unknown }) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

	send(data: string): void {
		if (this.readyState !== FakeSocket.OPEN) throw new Error("socket not open");
		this.sent.push(data);
	}

	close(code?: number): void {
		this.readyState = 3;
		this.onclose?.({ code: code ?? 1000 });
	}

	open(): void {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}

	receive(data: unknown): void {
		this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
	}

	lastSentJson(): Record<string, unknown> {
		return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
	}

	sentJson(): Record<string, unknown>[] {
		return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
	}
}

class FakeSocketFactory implements SocketFactory {
	sockets: FakeSocket[] = [];

	create(url: string, protocols?: string | string[]): WebSocketLike {
		void url;
		void protocols;
		const socket = new FakeSocket();
		this.sockets.push(socket);
		return socket;
	}

	get last(): FakeSocket {
		return this.sockets[this.sockets.length - 1];
	}
}

class FakeStore implements ContinuationChatStore {
	continuationChatId: number | null = null;
	flushCount = 0;

	setContinuationChatId(value: number | null): void {
		this.continuationChatId = value;
	}

	flush(): Promise<void> {
		this.flushCount += 1;
		return Promise.resolve();
	}
}

class FakeEditor implements ContinueWriterEditor {
	calls: Array<{ text: string; from: number; to: number }> = [];

	constructor(public text: string) {}

	replaceRange(text: string, from: number, to: number): void {
		this.calls.push({ text, from, to });
		this.text = this.text.slice(0, from) + text + this.text.slice(to);
	}

	getRange(from: number, to: number): string {
		return this.text.slice(from, to);
	}
}

function frame(category: string, event: Record<string, unknown>, eventId?: string): string {
	return JSON.stringify({ event_id: eventId, category, event });
}

interface Harness {
	writer: ContinueWriter;
	ws: FakeSocket;
	store: FakeStore;
	notices: string[];
	runningStates: boolean[];
}

async function createHarness(initialChatId: number | null = null): Promise<Harness> {
	const factory = new FakeSocketFactory();
	const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
	const store = new FakeStore();
	store.continuationChatId = initialChatId;
	const notices: string[] = [];
	const runningStates: boolean[] = [];
	const writer = new ContinueWriter(socket, store, {
		notice: (message) => notices.push(message),
		onRunningChange: (running) => runningStates.push(running)
	});
	const connectPromise = socket.connect();
	factory.last.open();
	await connectPromise;
	return { writer, ws: factory.last, store, notices, runningStates };
}

function startTurn(harness: Harness, chatId: number): void {
	harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: chatId }, "evt_ack"));
	harness.ws.receive(
		frame("chat", { type: "turn_start", chat_id: chatId, turn_id: "turn_1" }, "evt_start")
	);
}

function receiveText(harness: Harness, chatId: number, detail: Record<string, unknown>, eventId: string): void {
	harness.ws.receive(
		frame(
			"chat",
			{ type: "message", chat_id: chatId, turn_id: "turn_1", role: "assistant", detail },
			eventId
		)
	);
}

describe("ContinueWriter editor integrity", () => {
	it("aborts and stops the completion when the user edits before the insert point", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("开头的前文");
		harness.writer.start(editor, editor.text.length, "开头的前文");
		startTurn(harness, 321);
		receiveText(harness, 321, { type: "text", marker: "started", delta: "续写A" }, "evt_d1");
		expect(editor.text).toBe("开头的前文续写A");

		// 用户在插入点之前插入文本，所有 offset 失效
		editor.text = "插入!" + editor.text;
		receiveText(harness, 321, { type: "text", marker: "delta", delta: "续写B" }, "evt_d2");

		expect(harness.writer.isRunning).toBe(false);
		expect(editor.text).toBe("插入!开头的前文续写A");
		expect(harness.ws.lastSentJson()).toEqual({ type: "stop_completion", chat_id: 321 });
		expect(harness.notices).toContain("检测到文档被编辑，续写已中止");
	});

	it("keeps streaming when the user edits after the insertion range", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文——后记");
		harness.writer.start(editor, 2, "前文");
		startTurn(harness, 321);
		receiveText(harness, 321, { type: "text", marker: "started", delta: "续写A" }, "evt_d1");
		expect(editor.text).toBe("前文续写A——后记");

		// 在插入范围之后追加内容不影响 offset
		editor.text += "（用户追加）";
		receiveText(harness, 321, { type: "text", marker: "delta", delta: "续写B" }, "evt_d2");

		expect(harness.writer.isRunning).toBe(true);
		expect(editor.text).toBe("前文续写A续写B——后记（用户追加）");
	});

	it("aborts when the editor throws on insert", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, 2, "前文");
		startTurn(harness, 321);
		editor.replaceRange = () => {
			throw new Error("editor detached");
		};
		receiveText(harness, 321, { type: "text", marker: "started", delta: "续写" }, "evt_d1");

		expect(harness.writer.isRunning).toBe(false);
		expect(harness.notices).toContain("检测到文档被编辑，续写已中止");
	});
});

describe("ContinueWriter connection loss", () => {
	it("stops the run with a notice when the connection is lost mid-stream", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, 2, "前文");
		startTurn(harness, 321);
		receiveText(harness, 321, { type: "text", marker: "started", delta: "续写" }, "evt_d1");
		expect(harness.writer.isRunning).toBe(true);

		harness.ws.close(1006);

		expect(harness.writer.isRunning).toBe(false);
		expect(harness.notices).toContain("连接已断开，续写中止");
		expect(harness.runningStates).toEqual([true, false]);
	});
});

describe("continue prompt helpers", () => {
	it("buildContinuePrompt uses the fixed template", () => {
		expect(buildContinuePrompt("一些前文")).toBe(
			"请直接续写以下文字，不要重复原文，不要解释，直接输出续写内容：\n\n一些前文"
		);
	});

	it("extractContinuePrefix keeps the tail up to maxChars", () => {
		expect(extractContinuePrefix("abc", 4000)).toBe("abc");
		expect(extractContinuePrefix("abcdef", 4)).toBe("cdef");
	});

	it("extractContinuePrefix falls back to the default limit for invalid maxChars", () => {
		const long = "x".repeat(DEFAULT_CONTINUE_MAX_CHARS + 100);
		expect(extractContinuePrefix(long, 0)).toBe(long.slice(-DEFAULT_CONTINUE_MAX_CHARS));
		expect(extractContinuePrefix(long, Number.NaN)).toBe(long.slice(-DEFAULT_CONTINUE_MAX_CHARS));
	});
});

describe("ContinueWriter streaming insertion", () => {
	it("sends chat_completion with the stored chat id and prompt", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文内容");

		expect(harness.writer.start(editor, editor.text.length, "前文内容")).toBe(true);
		expect(harness.writer.isRunning).toBe(true);
		expect(harness.runningStates).toEqual([true]);
		expect(harness.ws.lastSentJson()).toEqual({
			type: "chat_completion",
			chat_id: 321,
			content: buildContinuePrompt("前文内容"),
			client_request_id: expect.any(String)
		});
	});

	it("accumulates deltas at the insertion point", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文内容");
		harness.writer.start(editor, editor.text.length, "前文内容");
		startTurn(harness, 321);

		receiveText(harness, 321, { type: "text", marker: "started", delta: "续", text: "" }, "evt_1");
		expect(editor.text).toBe("前文内容续");
		receiveText(harness, 321, { type: "text", marker: "delta", delta: "写", text: "" }, "evt_2");
		receiveText(harness, 321, { type: "text", marker: "delta", delta: "内容", text: "" }, "evt_3");
		expect(editor.text).toBe("前文内容续写内容");
		expect(editor.calls).toEqual([
			{ text: "续", from: 4, to: 4 },
			{ text: "写", from: 5, to: 5 },
			{ text: "内容", from: 6, to: 6 }
		]);
	});

	it("completed replaces the whole insertion region with the full text", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文内容");
		harness.writer.start(editor, editor.text.length, "前文内容");
		startTurn(harness, 321);

		receiveText(harness, 321, { type: "text", marker: "started", delta: "你", text: "" }, "evt_1");
		receiveText(harness, 321, { type: "text", marker: "delta", delta: "好", text: "" }, "evt_2");
		receiveText(
			harness,
			321,
			{ type: "text", marker: "completed", delta: "", text: "你好，世界！" },
			"evt_3"
		);
		expect(editor.text).toBe("前文内容你好，世界！");
		expect(editor.calls[editor.calls.length - 1]).toEqual({ text: "你好，世界！", from: 4, to: 6 });

		receiveText(
			harness,
			321,
			{ type: "text", marker: "completed", delta: "", text: "您好，世界。" },
			"evt_4"
		);
		expect(editor.text).toBe("前文内容您好，世界。");
		expect(editor.calls[editor.calls.length - 1]).toEqual({ text: "您好，世界。", from: 4, to: 10 });
	});

	it("hidden clears the inserted region and later deltas continue from the start", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, editor.text.length, "前文");
		startTurn(harness, 321);

		receiveText(harness, 321, { type: "text", marker: "started", delta: "草稿", text: "" }, "evt_1");
		expect(editor.text).toBe("前文草稿");
		receiveText(harness, 321, { type: "text", marker: "hidden" }, "evt_2");
		expect(editor.text).toBe("前文");
		receiveText(harness, 321, { type: "text", marker: "delta", delta: "正式", text: "" }, "evt_3");
		expect(editor.text).toBe("前文正式");
	});

	it("turn_end ok finalizes, hides the status and unlocks", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, editor.text.length, "前文");
		startTurn(harness, 321);
		receiveText(harness, 321, { type: "text", marker: "started", delta: "续", text: "" }, "evt_1");

		harness.ws.receive(
			frame("chat", { type: "turn_end", chat_id: 321, turn_id: "turn_1", status: "ok" }, "evt_end")
		);
		expect(harness.writer.isRunning).toBe(false);
		expect(harness.runningStates).toEqual([true, false]);
		expect(harness.notices).toEqual([]);

		expect(harness.writer.start(editor, editor.text.length, "前文续")).toBe(true);
		expect(harness.runningStates).toEqual([true, false, true]);
	});

	it("ignores log events and events from other chats", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, editor.text.length, "前文");
		startTurn(harness, 321);

		harness.ws.receive(
			frame(
				"chat",
				{
					type: "log",
					chat_id: 321,
					turn_id: "turn_1",
					log: { type: "thinking", marker: "delta", delta: "思考中", reasoning: "" }
				},
				"evt_log"
			)
		);
		receiveText(harness, 999, { type: "text", marker: "delta", delta: "别的会话", text: "" }, "evt_other");
		expect(editor.text).toBe("前文");
		expect(editor.calls).toEqual([]);
	});
});

describe("ContinueWriter stop and concurrency", () => {
	it("stop sends stop_completion and later deltas are not inserted", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("正文");
		harness.writer.start(editor, editor.text.length, "正文");
		startTurn(harness, 321);
		receiveText(harness, 321, { type: "text", marker: "started", delta: "A", text: "" }, "evt_1");
		expect(editor.text).toBe("正文A");

		harness.writer.stop();
		expect(harness.ws.lastSentJson()).toEqual({ type: "stop_completion", chat_id: 321 });

		receiveText(harness, 321, { type: "text", marker: "delta", delta: "B", text: "" }, "evt_2");
		expect(editor.text).toBe("正文A");

		harness.ws.receive(
			frame("chat", { type: "turn_end", chat_id: 321, turn_id: "turn_1", status: "cancelled" }, "evt_end")
		);
		expect(harness.writer.isRunning).toBe(false);
		expect(harness.runningStates).toEqual([true, false]);

		receiveText(harness, 321, { type: "text", marker: "delta", delta: "C", text: "" }, "evt_3");
		expect(editor.text).toBe("正文A");
	});

	it("stop before the ack defers stop_completion until the chat id is known", async () => {
		const harness = await createHarness(null);
		const editor = new FakeEditor("x");
		harness.writer.start(editor, editor.text.length, "x");
		expect(harness.ws.lastSentJson()).toMatchObject({ type: "chat_completion", chat_id: null });

		harness.writer.stop();
		expect(harness.ws.sentJson().some((entry) => entry.type === "stop_completion")).toBe(false);

		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 555 }, "evt_ack"));
		expect(harness.store.continuationChatId).toBe(555);
		expect(harness.store.flushCount).toBe(1);
		expect(harness.ws.lastSentJson()).toEqual({ type: "stop_completion", chat_id: 555 });

		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 555, turn_id: "turn_1" }, "evt_start"));
		receiveText(harness, 555, { type: "text", marker: "started", delta: "A", text: "" }, "evt_1");
		expect(editor.text).toBe("x");
	});

	it("rejects a concurrent start with a notice", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("abc");
		expect(harness.writer.start(editor, editor.text.length, "abc")).toBe(true);
		expect(harness.writer.start(editor, editor.text.length, "abc")).toBe(false);
		expect(harness.notices).toEqual(["已有续写任务正在执行"]);
		expect(harness.ws.sentJson().filter((entry) => entry.type === "chat_completion")).toHaveLength(1);
	});

	it("notices when there is nothing before the cursor", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("");
		expect(harness.writer.start(editor, 0, "")).toBe(false);
		expect(harness.writer.start(editor, 0, "   \n")).toBe(false);
		expect(harness.notices).toEqual(["光标前没有可续写的内容", "光标前没有可续写的内容"]);
		expect(harness.ws.sent).toHaveLength(0);
		expect(harness.writer.isRunning).toBe(false);
	});
});

describe("ContinueWriter chat id backfill and errors", () => {
	it("backfills continuationChatId from the ack of a new chat and persists once", async () => {
		const harness = await createHarness(null);
		const editor = new FakeEditor("开头");
		harness.writer.start(editor, editor.text.length, "开头");
		expect(harness.ws.lastSentJson()).toMatchObject({ type: "chat_completion", chat_id: null });

		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 555 }, "evt_ack"));
		expect(harness.store.continuationChatId).toBe(555);
		expect(harness.store.flushCount).toBe(1);

		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 555 }, "evt_ack_dup"));
		expect(harness.store.flushCount).toBe(1);
	});

	it("ignores acks echoing a different client_request_id", async () => {
		const harness = await createHarness(null);
		const editor = new FakeEditor("开头");
		harness.writer.start(editor, editor.text.length, "开头");

		harness.ws.receive(
			frame(
				"system",
				{
					type: "chat_completion_ack",
					chat_id: 777,
					request: { type: "chat_completion", client_request_id: "someone-else" }
				},
				"evt_ack_other"
			)
		);
		expect(harness.store.continuationChatId).toBeNull();
		expect(harness.store.flushCount).toBe(0);

		const requestId = harness.ws.lastSentJson().client_request_id;
		harness.ws.receive(
			frame(
				"system",
				{
					type: "chat_completion_ack",
					chat_id: 555,
					request: { type: "chat_completion", client_request_id: requestId }
				},
				"evt_ack"
			)
		);
		expect(harness.store.continuationChatId).toBe(555);
		expect(harness.store.flushCount).toBe(1);
	});

	it("turn_end error notices the message and unlocks", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, editor.text.length, "前文");
		startTurn(harness, 321);

		harness.ws.receive(
			frame(
				"chat",
				{ type: "turn_end", chat_id: 321, turn_id: "turn_1", status: "error", error: "服务繁忙" },
				"evt_end"
			)
		);
		expect(harness.notices).toEqual(["服务繁忙"]);
		expect(harness.writer.isRunning).toBe(false);
		expect(harness.runningStates).toEqual([true, false]);
	});

	it("a socket error for this request finalizes, foreign errors are ignored", async () => {
		const harness = await createHarness(321);
		const editor = new FakeEditor("前文");
		harness.writer.start(editor, editor.text.length, "前文");
		const requestId = harness.ws.lastSentJson().client_request_id;

		harness.ws.receive(
			frame(
				"system",
				{
					type: "error",
					message: "别的请求失败",
					request: { type: "chat_completion", client_request_id: "someone-else" }
				},
				"evt_err_other"
			)
		);
		expect(harness.writer.isRunning).toBe(true);
		expect(harness.notices).toEqual([]);

		harness.ws.receive(
			frame(
				"system",
				{
					type: "error",
					message: "同一会话仅允许一个续写任务",
					request: { type: "chat_completion", client_request_id: requestId }
				},
				"evt_err"
			)
		);
		expect(harness.notices).toEqual(["同一会话仅允许一个续写任务"]);
		expect(harness.writer.isRunning).toBe(false);
		expect(harness.runningStates).toEqual([true, false]);
	});
});
