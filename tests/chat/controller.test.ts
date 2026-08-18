import { describe, expect, it } from "vitest";
import { ChatController } from "../../src/chat/controller";
import type { ChatControllerState } from "../../src/chat/controller";
import { PuzleClient } from "../../src/core/api/client";
import type { ReadingItem, ResourceType } from "../../src/core/models";
import type { HttpMethod, HttpPort, HttpRequestOptions, HttpResponse, SocketFactory, WebSocketLike } from "../../src/core/ports";
import { PuzleSocket } from "../../src/core/ws/manager";

const WS_URL = "wss://read-web-test.puzle.com.cn/api/v1/agent/events";
const BASE_URL = "https://read-web-test.puzle.com.cn";
const TOKEN = "test-jwt-token";

class FakeSocket implements WebSocketLike {
	static readonly OPEN = 1;
	readyState = 0;
	sent: string[] = [];
	onopen: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data?: unknown }) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

	constructor(
		readonly url: string,
		readonly protocols?: string | string[]
	) {}

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
		const socket = new FakeSocket(url, protocols);
		this.sockets.push(socket);
		return socket;
	}

	get last(): FakeSocket {
		return this.sockets[this.sockets.length - 1];
	}
}

class FakeHttpPort implements HttpPort {
	items: ReadingItem[] = [];
	requests: Array<{ method: HttpMethod; url: string }> = [];

	async request(opts: HttpRequestOptions): Promise<HttpResponse> {
		this.requests.push({ method: opts.method ?? "GET", url: opts.url });
		const url = new URL(opts.url);
		const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
		const pageSize = Number.parseInt(url.searchParams.get("page_size") ?? "50", 10);
		const start = (page - 1) * pageSize;
		const slice = this.items.slice(start, start + pageSize);
		return {
			status: 200,
			json: { code: 0, data: { items: slice, total: this.items.length, page, page_size: pageSize } },
			text: ""
		};
	}
}

function frame(category: string, event: Record<string, unknown>, eventId?: string): string {
	return JSON.stringify({ event_id: eventId, category, event });
}

function readingItem(partial: Partial<ReadingItem> & { id: number; resource_type: ResourceType }): ReadingItem {
	return {
		task_id: partial.id * 10,
		resource_id: partial.id,
		created_time: "2026-03-18T14:46:40Z",
		highlight_count: 0,
		puzle_id: 1727,
		domain: "example.com",
		...partial
	};
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
	controller: ChatController;
	ws: FakeSocket;
	http: FakeHttpPort;
	states: ChatControllerState[];
	latest(): ChatControllerState;
}

async function createHarness(): Promise<Harness> {
	const factory = new FakeSocketFactory();
	const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
	const http = new FakeHttpPort();
	const client = new PuzleClient(BASE_URL, TOKEN, http);
	const controller = new ChatController(socket, client);
	const connectPromise = socket.connect();
	factory.last.open();
	await connectPromise;
	const states: ChatControllerState[] = [];
	controller.subscribe((state) => states.push(state));
	return {
		controller,
		ws: factory.last,
		http,
		states,
		latest: () => states[states.length - 1]
	};
}

describe("ChatController sessions", () => {
	it("loadSessions keeps only chat items with title and chat_id", async () => {
		const harness = await createHarness();
		harness.http.items = [
			readingItem({ id: 1, resource_type: "link", chat_id: 5, title: "一篇链接文章" }),
			readingItem({ id: 2, resource_type: "chat", chat_id: 214, title: "关于阅读层次的讨论", status: "done" }),
			readingItem({ id: 3, resource_type: "chat", chat_id: 9, title: null })
		];

		await harness.controller.loadSessions();

		expect(harness.latest().sessions).toEqual([
			{
				chatId: 214,
				title: "关于阅读层次的讨论",
				status: "done",
				createdTime: "2026-03-18T14:46:40Z"
			},
			{ chatId: 9, title: "对话 9", status: null, createdTime: "2026-03-18T14:46:40Z" }
		]);
	});

	it("openSession loads full history and maps turns to messages", async () => {
		const harness = await createHarness();
		harness.http.items = [
			readingItem({ id: 2, resource_type: "chat", chat_id: 214, title: "关于阅读层次的讨论" })
		];
		await harness.controller.loadSessions();

		const promise = harness.controller.openSession(214);
		expect(harness.latest().active).toMatchObject({ chatId: 214, loading: true, messages: [] });
		expect(harness.ws.lastSentJson()).toMatchObject({ type: "chat_history", chat_id: 214, offset: 0, limit: 40 });

		harness.ws.receive(
			frame(
				"system",
				{
					type: "chat_history_response",
					chat_id: 214,
					title: "关于阅读层次的讨论",
					total: 1,
					has_more: false,
					turns: [
						{
							turn_id: "turn_h1",
							events: [
								{ type: "message", role: "user", detail: [{ type: "text", text: "阅读有几个层次？" }] },
								{
									type: "message",
									role: "assistant",
									detail: { type: "text", marker: "full", text: "共四个层次。" }
								},
								{ type: "log", log: { type: "thinking", reasoning: "回忆《如何阅读一本书》" } }
							]
						}
					]
				},
				"evt_h1"
			)
		);
		await promise;

		const active = harness.latest().active;
		expect(active.chatId).toBe(214);
		expect(active.title).toBe("关于阅读层次的讨论");
		expect(active.loading).toBe(false);
		expect(active.streaming).toBe(false);
		expect(active.messages).toEqual([
			{ id: "user-turn_h1", role: "user", content: "阅读有几个层次？", turnId: "turn_h1" },
			{
				id: "assistant-turn_h1",
				role: "assistant",
				content: "共四个层次。",
				turnId: "turn_h1",
				logs: [{ type: "thinking", reasoning: "回忆《如何阅读一本书》" }]
			}
		]);
	});

	it("newSession resets the active chat", async () => {
		const harness = await createHarness();
		harness.controller.newSession();
		const active = harness.latest().active;
		expect(active.chatId).toBeNull();
		expect(active.title).toBeNull();
		expect(active.messages).toEqual([]);
		expect(active.streaming).toBe(false);
	});
});

describe("ChatController streaming", () => {
	it("send on a new chat backfills chat_id from the ack and refreshes sessions", async () => {
		const harness = await createHarness();
		harness.http.items = [readingItem({ id: 4, resource_type: "chat", chat_id: 42, title: "新对话" })];

		harness.controller.send("  阅读的四个层次是什么？  ");

		expect(harness.ws.lastSentJson()).toMatchObject({
			type: "chat_completion",
			chat_id: null,
			content: "阅读的四个层次是什么？"
		});
		expect(typeof harness.ws.lastSentJson().client_request_id).toBe("string");
		const active = harness.latest().active;
		expect(active.chatId).toBeNull();
		expect(active.streaming).toBe(true);
		expect(active.messages).toHaveLength(1);
		expect(active.messages[0]).toMatchObject({ role: "user", content: "阅读的四个层次是什么？" });

		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 42, puzle_id: 1 }, "evt_ack"));
		expect(harness.latest().active.chatId).toBe(42);

		await flush();
		expect(harness.http.requests.some((entry) => entry.url.includes("/api/v1/reading/items"))).toBe(true);
		expect(harness.latest().sessions).toEqual([
			{ chatId: 42, title: "新对话", status: null, createdTime: "2026-03-18T14:46:40Z" }
		]);
	});

	it("accumulates streaming deltas and returns to idle on turn_end", async () => {
		const harness = await createHarness();
		harness.controller.send("你好");
		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 42 }, "evt_ack"));
		await flush();

		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 42, turn_id: "turn_1" }, "evt_1"));
		harness.ws.receive(
			frame(
				"chat",
				{ type: "message", chat_id: 42, turn_id: "turn_1", detail: { type: "text", marker: "started", delta: "你" } },
				"evt_2"
			)
		);
		const assistantOf = (state: ChatControllerState) => state.active.messages[state.active.messages.length - 1];
		expect(assistantOf(harness.latest())).toMatchObject({ role: "assistant", content: "你" });

		const before = harness.latest().active.messages;
		harness.ws.receive(
			frame(
				"chat",
				{ type: "message", chat_id: 42, turn_id: "turn_1", detail: { type: "text", marker: "delta", delta: "好！" } },
				"evt_3"
			)
		);
		expect(assistantOf(harness.latest()).content).toBe("你好！");
		expect(harness.latest().active.messages).not.toBe(before);

		harness.ws.receive(
			frame(
				"chat",
				{ type: "message", chat_id: 42, turn_id: "turn_1", detail: { type: "text", marker: "hidden" } },
				"evt_4"
			)
		);
		expect(assistantOf(harness.latest()).content).toBe("");

		harness.ws.receive(
			frame(
				"chat",
				{
					type: "message",
					chat_id: 42,
					turn_id: "turn_1",
					detail: { type: "text", marker: "completed", text: "你好！有什么可以帮你？" }
				},
				"evt_5"
			)
		);
		expect(assistantOf(harness.latest()).content).toBe("你好！有什么可以帮你？");

		harness.ws.receive(
			frame("chat", { type: "turn_end", chat_id: 42, turn_id: "turn_1", status: "ok" }, "evt_6")
		);
		const active = harness.latest().active;
		expect(active.streaming).toBe(false);
		expect(active.error).toBeNull();
		expect(active.messages).toHaveLength(2);
		expect(active.messages[1]).toMatchObject({
			role: "assistant",
			content: "你好！有什么可以帮你？",
			turnId: "turn_1"
		});
		expect(active.messages[1].id).not.toMatch(/^streaming-/);
	});

	it("ignores chat events for other chat ids and title_generated updates the title", async () => {
		const harness = await createHarness();
		harness.controller.send("你好");
		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 42 }, "evt_ack"));

		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 42, turn_id: "turn_1" }, "evt_1"));
		harness.ws.receive(
			frame(
				"chat",
				{ type: "message", chat_id: 999, turn_id: "turn_x", detail: { type: "text", marker: "delta", delta: "别的会话" } },
				"evt_other"
			)
		);
		expect(harness.latest().active.messages).toHaveLength(2);

		harness.ws.receive(frame("chat", { type: "title_generated", chat_id: 42, title: "问候" }, "evt_title"));
		expect(harness.latest().active.title).toBe("问候");
		expect(harness.latest().sessions.some((entry) => entry.chatId === 42 && entry.title === "问候")).toBe(true);

		harness.ws.receive(frame("chat", { type: "turn_end", chat_id: 42, turn_id: "turn_1", status: "ok" }, "evt_end"));
		expect(harness.latest().active.streaming).toBe(false);
	});

	it("stop sends stop_completion and cancelled turn_end clears streaming", async () => {
		const harness = await createHarness();
		harness.controller.send("写一篇长文");
		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 7 }, "evt_ack"));
		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 7, turn_id: "turn_1" }, "evt_1"));

		harness.controller.stop();
		expect(harness.ws.lastSentJson()).toEqual({ type: "stop_completion", chat_id: 7 });

		harness.ws.receive(
			frame("chat", { type: "turn_end", chat_id: 7, turn_id: "turn_1", status: "cancelled" }, "evt_end")
		);
		const active = harness.latest().active;
		expect(active.streaming).toBe(false);
		expect(active.error).toBeNull();
		expect(active.messages).toHaveLength(1);
	});

	it("reports an error message when the turn ends with status error", async () => {
		const harness = await createHarness();
		harness.controller.send("你好");
		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 42 }, "evt_ack"));
		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 42, turn_id: "turn_1" }, "evt_1"));
		harness.ws.receive(
			frame(
				"chat",
				{ type: "turn_end", chat_id: 42, turn_id: "turn_1", status: "error", error: "服务繁忙" },
				"evt_end"
			)
		);
		const active = harness.latest().active;
		expect(active.streaming).toBe(false);
		expect(active.error).toBe("服务繁忙");
	});

	it("ignores acks and mid-stream events belonging to another consumer (AI 续写)", async () => {
		const harness = await createHarness();
		harness.controller.send("你好");
		const requestId = harness.ws.lastSentJson().client_request_id as string;

		// 续写器的 ack：client_request_id 不匹配，不应认领
		harness.ws.receive(
			frame(
				"system",
				{ type: "chat_completion_ack", chat_id: 900, request: { client_request_id: "puzle-continue-x" } },
				"evt_ack_other"
			)
		);
		expect(harness.latest().active.chatId).toBeNull();

		// 续写器已在流式中的 message 事件（无 turn_start）也不应被认领
		harness.ws.receive(
			frame(
				"chat",
				{ type: "message", chat_id: 900, turn_id: "turn_w", detail: { type: "text", marker: "delta", delta: "续写内容" } },
				"evt_w1"
			)
		);
		expect(harness.latest().active.messages).toHaveLength(1);

		// 自己的 ack 正常认领
		harness.ws.receive(
			frame(
				"system",
				{ type: "chat_completion_ack", chat_id: 42, request: { client_request_id: requestId } },
				"evt_ack_mine"
			)
		);
		expect(harness.latest().active.chatId).toBe(42);
	});

	it("resets streaming with an error when the connection is lost mid-turn", async () => {
		const harness = await createHarness();
		harness.controller.send("你好");
		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 42 }, "evt_ack"));
		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 42, turn_id: "turn_1" }, "evt_1"));
		harness.ws.receive(
			frame(
				"chat",
				{ type: "message", chat_id: 42, turn_id: "turn_1", detail: { type: "text", marker: "started", delta: "部分回复" } },
				"evt_2"
			)
		);
		expect(harness.latest().active.streaming).toBe(true);

		harness.ws.close(1006);

		const active = harness.latest().active;
		expect(active.streaming).toBe(false);
		expect(active.error).toContain("连接已断开");
		const last = active.messages[active.messages.length - 1];
		expect(last).toMatchObject({ role: "assistant", content: "部分回复" });
		expect(last.id).not.toMatch(/^streaming-/);
	});

	it("drops an empty streaming placeholder when the connection is lost", async () => {
		const harness = await createHarness();
		harness.controller.send("你好");
		harness.ws.receive(frame("system", { type: "chat_completion_ack", chat_id: 42 }, "evt_ack"));
		harness.ws.receive(frame("chat", { type: "turn_start", chat_id: 42, turn_id: "turn_1" }, "evt_1"));

		harness.ws.close(1006);

		const active = harness.latest().active;
		expect(active.streaming).toBe(false);
		expect(active.messages).toHaveLength(1);
		expect(active.messages[0].role).toBe("user");
	});

	it("ignores send while streaming and empty input", async () => {
		const harness = await createHarness();
		harness.controller.send("   ");
		expect(harness.ws.sent).toHaveLength(0);

		harness.controller.send("你好");
		harness.controller.send("再来一条");
		expect(harness.ws.sentJson().filter((entry) => entry.type === "chat_completion")).toHaveLength(1);
		expect(harness.latest().active.messages).toHaveLength(1);
	});
});
