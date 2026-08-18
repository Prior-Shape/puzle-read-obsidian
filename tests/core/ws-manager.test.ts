import { describe, expect, it, vi } from "vitest";
import {
	DEDUP_CACHE_SIZE,
	HISTORY_PAGE_LIMIT,
	PuzleSocket
} from "../../src/core/ws/manager";
import type { SocketFactory, WebSocketLike } from "../../src/core/ports";
import type { WsChatHistoryResponse, WsEvent } from "../../src/core/ws/types";

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

	serverClose(code: number): void {
		this.readyState = 3;
		this.onclose?.({ code });
	}

	fail(): void {
		this.onerror?.();
	}

	lastSentJson(): Record<string, unknown> {
		return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
	}
}

class FakeSocketFactory implements SocketFactory {
	sockets: FakeSocket[] = [];
	create(url: string, protocols?: string | string[]): WebSocketLike {
		const socket = new FakeSocket(url, protocols);
		this.sockets.push(socket);
		return socket;
	}
	get created(): number {
		return this.sockets.length;
	}
	get last(): FakeSocket {
		return this.sockets[this.sockets.length - 1];
	}
}

function frame(category: string, event: Record<string, unknown>, eventId?: string): string {
	return JSON.stringify({ event_id: eventId, category, event });
}

async function connectSocket(socket: PuzleSocket, factory: FakeSocketFactory): Promise<void> {
	const promise = socket.connect();
	factory.last.open();
	await promise;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("PuzleSocket connection & auth", () => {
	it("authenticates via the puzle-auth-v1.<token> subprotocol", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		expect(factory.created).toBe(1);
		expect(factory.last.url).toBe(WS_URL);
		expect(factory.last.protocols).toEqual([`puzle-auth-v1.${TOKEN}`]);
		expect(socket.isConnected).toBe(true);
	});

	it("connects without a subprotocol when the token is empty", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => "", factory);
		await connectSocket(socket, factory);

		expect(factory.last.protocols).toBeUndefined();
	});

	it("reuses the pending connection promise and resolves immediately when open", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		const first = socket.connect();
		const second = socket.connect();
		expect(second).toBe(first);
		factory.last.open();
		await first;
		await socket.connect();
		expect(factory.created).toBe(1);
	});

	it("rejects connect and never reconnects on auth failure (4001)", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0.5 });
			const promise = socket.connect();
			factory.last.serverClose(4001);
			await expect(promise).rejects.toThrow("Authentication failed");

			vi.advanceTimersByTime(120000);
			expect(factory.created).toBe(1);
			expect(socket.isConnected).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reconnect after a normal close (1000)", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0.5 });
			await connectSocket(socket, factory);
			factory.last.serverClose(1000);

			vi.advanceTimersByTime(120000);
			expect(factory.created).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("heartbeat", () => {
	it("sends a text ping every 25s and ignores pong replies", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
			await connectSocket(socket, factory);

			expect(factory.last.sent).toEqual([]);
			vi.advanceTimersByTime(25000);
			expect(factory.last.sent).toEqual(["ping"]);
			vi.advanceTimersByTime(25000);
			expect(factory.last.sent).toEqual(["ping", "ping"]);

			const events: WsEvent[] = [];
			socket.on("system", (event) => events.push(event));
			socket.on("chat", (event) => events.push(event));
			factory.last.receive("pong");
			expect(events).toEqual([]);

			factory.last.serverClose(1000);
			vi.advanceTimersByTime(60000);
			expect(factory.last.sent).toEqual(["ping", "ping"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("event dedup & frame compatibility", () => {
	it("dispatches each event_id only once within the 200-entry cache", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const events: WsEvent[] = [];
		socket.on("chat", (event) => events.push(event));

		factory.last.receive(frame("chat", { type: "message", chat_id: 1 }, "evt_1"));
		factory.last.receive(frame("chat", { type: "message", chat_id: 1 }, "evt_1"));
		expect(events).toHaveLength(1);

		for (let i = 0; i < DEDUP_CACHE_SIZE; i += 1) {
			factory.last.receive(frame("chat", { type: "message", chat_id: 1 }, `evt_fill_${i}`));
		}
		expect(events).toHaveLength(1 + DEDUP_CACHE_SIZE);

		factory.last.receive(frame("chat", { type: "message", chat_id: 1 }, "evt_1"));
		expect(events).toHaveLength(2 + DEDUP_CACHE_SIZE);
	});

	it("dispatches wrapped, inner-only and flattened frames", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const chat: WsEvent[] = [];
		const system: WsEvent[] = [];
		socket.on("chat", (event) => chat.push(event));
		socket.on("system", (event) => system.push(event));

		factory.last.receive(frame("chat", { type: "turn_start", chat_id: 1 }, "evt_a"));
		factory.last.receive(JSON.stringify({ event_id: "evt_b", event: { type: "agent_task_history_response" } }));
		factory.last.receive(JSON.stringify({ event_id: "evt_c", type: "chat_history_response", chat_id: 9 }));

		expect(chat.map((event) => event.type)).toEqual(["turn_start"]);
		expect(system.map((event) => event.type)).toEqual(["agent_task_history_response", "chat_history_response"]);
	});

	it("ignores non-JSON and type-less frames", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const events: WsEvent[] = [];
		socket.on("system", (event) => events.push(event));
		socket.on("chat", (event) => events.push(event));

		factory.last.receive("not json at all");
		factory.last.receive(JSON.stringify({ event_id: "evt_x", category: "chat", event: {} }));
		factory.last.receive(JSON.stringify({ event_id: "evt_y", category: "chat" }));
		expect(events).toEqual([]);
	});

	it("unsubscribe stops further dispatch", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const events: WsEvent[] = [];
		const unsubscribe = socket.on("chat", (event) => events.push(event));
		factory.last.receive(frame("chat", { type: "turn_start" }, "evt_1"));
		unsubscribe();
		factory.last.receive(frame("chat", { type: "turn_start" }, "evt_2"));
		expect(events).toHaveLength(1);
	});
});

describe("reconnect backoff", () => {
	it("reconnects with exponential backoff plus jitter and caps at 30s", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0.5 });
			await connectSocket(socket, factory);

			const expectedDelays = [1500, 2500, 4500, 8500, 16500, 30000, 30000];
			for (let attempt = 0; attempt < expectedDelays.length; attempt += 1) {
				factory.last.serverClose(1006);
				const createdBefore = factory.created;
				vi.advanceTimersByTime(expectedDelays[attempt] - 1);
				expect(factory.created).toBe(createdBefore);
				vi.advanceTimersByTime(1);
				expect(factory.created).toBe(createdBefore + 1);
			}

			factory.last.open();
			expect(socket.isConnected).toBe(true);

			factory.last.serverClose(1006);
			const createdBefore = factory.created;
			vi.advanceTimersByTime(1499);
			expect(factory.created).toBe(createdBefore);
			vi.advanceTimersByTime(1);
			expect(factory.created).toBe(createdBefore + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects after a connection error and resets attempts on open", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0 });
			const promise = socket.connect();
			factory.last.fail();
			await expect(promise).rejects.toThrow("WebSocket error");

			vi.advanceTimersByTime(1000);
			expect(factory.created).toBe(2);
			factory.last.open();

			factory.last.serverClose(1006);
			vi.advanceTimersByTime(1000);
			expect(factory.created).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("disconnect disposes the socket: no reconnect, no send, no connect", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0.5 });
			await connectSocket(socket, factory);

			socket.disconnect();
			expect(socket.isConnected).toBe(false);

			vi.advanceTimersByTime(120000);
			expect(factory.created).toBe(1);

			socket.send({ type: "stop_completion", chat_id: 1 });
			expect(factory.last.sent).toEqual([]);
			await expect(socket.connect()).rejects.toThrow(/disposed/);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("connection lifecycle notifications", () => {
	it("notifies connection-lost listeners when an established connection drops", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0.5 });
			await connectSocket(socket, factory);

			let lost = 0;
			socket.onConnectionLost(() => {
				lost += 1;
			});
			factory.last.serverClose(1006);
			expect(lost).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not notify when a pre-open reconnect attempt fails (queue survives)", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory, { random: () => 0.5 });
			let lost = 0;
			socket.onConnectionLost(() => {
				lost += 1;
			});

			socket.sendChatCompletion({ chat_id: null, content: "hi" });
			factory.last.serverClose(1006);
			expect(lost).toBe(0);

			vi.advanceTimersByTime(2000);
			factory.last.open();
			expect(factory.last.sent).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("notifies on a terminal close even before open (queue is dropped)", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		let lost = 0;
		socket.onConnectionLost(() => {
			lost += 1;
		});
		socket.sendChatCompletion({ chat_id: null, content: "hi" });
		factory.last.serverClose(4001);
		expect(lost).toBe(1);
	});

	it("refresh tears down the connection but keeps the socket usable with fresh url/token", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			let url = "wss://a.example/api/v1/agent/events";
			let token = "token-a";
			const socket = new PuzleSocket(() => url, () => token, factory, { random: () => 0.5 });
			await connectSocket(socket, factory);
			expect(factory.last.url).toBe("wss://a.example/api/v1/agent/events");

			let lost = 0;
			socket.onConnectionLost(() => {
				lost += 1;
			});
			url = "wss://b.example/api/v1/agent/events";
			token = "token-b";
			socket.refresh();
			expect(lost).toBe(1);
			expect(socket.isConnected).toBe(false);

			vi.advanceTimersByTime(120000);
			expect(factory.created).toBe(1);

			await connectSocket(socket, factory);
			expect(factory.created).toBe(2);
			expect(factory.last.url).toBe("wss://b.example/api/v1/agent/events");
			expect(factory.last.protocols).toEqual(["puzle-auth-v1.token-b"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("request / response pairing", () => {
	it("sends the request frame and resolves on the matching response", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const promise = socket.request<WsChatHistoryResponse>(
			"chat_history",
			{ chat_id: 7, offset: 0, limit: 20 },
			(event) => (event as { chat_id?: unknown }).chat_id === 7
		);

		expect(factory.last.lastSentJson()).toEqual({ type: "chat_history", chat_id: 7, offset: 0, limit: 20 });

		factory.last.receive(
			frame("system", { type: "chat_history_response", chat_id: 8, turns: [], has_more: false }, "evt_r1")
		);
		factory.last.receive(
			frame("system", { type: "chat_history_response", chat_id: 7, turns: [], has_more: false }, "evt_r2")
		);
		await expect(promise).resolves.toMatchObject({ chat_id: 7, has_more: false });
	});

	it("rejects on an error response scoped to the same request type", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const promise = socket.request("chat_history", { chat_id: 7 });
		factory.last.receive(
			frame("system", { type: "error", message: "locked", request: { type: "stop_completion" } }, "evt_e1")
		);
		factory.last.receive(
			frame("system", { type: "error", message: "chat is locked", request: { type: "chat_history" } }, "evt_e2")
		);
		await expect(promise).rejects.toThrow("chat is locked");
	});

	it("rejects pending requests when the connection drops", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const promise = socket.request("chat_history", { chat_id: 7 });
		factory.last.serverClose(1006);
		await expect(promise).rejects.toThrow(/closed/);
	});

	it("times out when no response arrives", async () => {
		vi.useFakeTimers();
		try {
			const factory = new FakeSocketFactory();
			const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
			await connectSocket(socket, factory);

			const promise = socket.request("chat_history", { chat_id: 7 });
			vi.advanceTimersByTime(15000);
			await expect(promise).rejects.toThrow("WebSocket request timed out: chat_history");
		} finally {
			vi.useRealTimers();
		}
	});

	it("queues outbound messages while disconnected and flushes on open", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);

		socket.sendChatCompletion({ chat_id: null, content: "你好" });
		expect(factory.created).toBe(1);
		expect(factory.last.sent).toEqual([]);

		factory.last.open();
		expect(factory.last.sent).toHaveLength(1);
		expect(factory.last.lastSentJson()).toEqual({ type: "chat_completion", chat_id: null, content: "你好" });
	});
});

describe("chat convenience methods", () => {
	it("sendChatCompletion sends chat_completion with optional fields", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		socket.sendChatCompletion({
			chat_id: null,
			content: "总结这篇文章",
			context: { type: "reading", params: { reading_id: 456 } },
			client_request_id: "req-1"
		});
		expect(factory.last.lastSentJson()).toEqual({
			type: "chat_completion",
			chat_id: null,
			content: "总结这篇文章",
			context: { type: "reading", params: { reading_id: 456 } },
			client_request_id: "req-1"
		});

		socket.sendChatCompletion({ chat_id: 214, content: "继续" });
		expect(factory.last.lastSentJson()).toEqual({ type: "chat_completion", chat_id: 214, content: "继续" });
	});

	it("stopCompletion sends stop_completion", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		socket.stopCompletion(214);
		expect(factory.last.lastSentJson()).toEqual({ type: "stop_completion", chat_id: 214 });
	});

	it("requestChatHistory pairs by chat_id including the echoed request", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const promise = socket.requestChatHistory(214, 0, 20);
		expect(factory.last.lastSentJson()).toEqual({ type: "chat_history", chat_id: 214, offset: 0, limit: 20 });

		factory.last.receive(
			frame(
				"system",
				{
					type: "chat_history_response",
					chat_id: 214,
					request: { type: "chat_history", chat_id: 214, offset: 0, limit: 20 },
					turns: [{ turn_id: "turn_1", events: [] }],
					total: 1,
					has_more: false
				},
				"evt_h1"
			)
		);
		const response = await promise;
		expect(response.turns).toHaveLength(1);
	});

	it("requestFullChatHistory loops with page size 40 until has_more is false", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const respond = (offset: number, turnCount: number, hasMore: boolean) => {
			factory.last.receive(
				frame(
					"system",
					{
						type: "chat_history_response",
						chat_id: 9,
						request: { type: "chat_history", chat_id: 9, offset, limit: HISTORY_PAGE_LIMIT },
						turns: Array.from({ length: turnCount }, (_, i) => ({
							turn_id: `turn_${offset + i}`,
							events: []
						})),
						total: 45,
						has_more: hasMore
					},
					`evt_page_${offset}`
				)
			);
		};

		const promise = socket.requestFullChatHistory(9);
		expect(factory.last.lastSentJson()).toMatchObject({ type: "chat_history", chat_id: 9, offset: 0, limit: 40 });
		respond(0, 40, true);
		await flush();
		expect(factory.last.lastSentJson()).toMatchObject({ type: "chat_history", chat_id: 9, offset: 40, limit: 40 });
		respond(40, 5, false);

		const result = await promise;
		expect(result).not.toBeNull();
		expect(result?.turns).toHaveLength(45);
		expect(result?.turns[0].turn_id).toBe("turn_0");
		expect(result?.turns[44].turn_id).toBe("turn_44");
		expect(result?.has_more).toBe(false);
	});

	it("requestFullChatHistory stops on an empty page even when has_more is true", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		const promise = socket.requestFullChatHistory(9);
		factory.last.receive(
			frame(
				"system",
				{ type: "chat_history_response", chat_id: 9, turns: [], total: 45, has_more: true },
				"evt_empty"
			)
		);
		const result = await promise;
		expect(result?.turns).toEqual([]);
		expect(factory.last.sent.filter((msg) => msg.includes("chat_history"))).toHaveLength(1);
	});

	it("requestFullChatHistory honours cancellation", async () => {
		const factory = new FakeSocketFactory();
		const socket = new PuzleSocket(WS_URL, () => TOKEN, factory);
		await connectSocket(socket, factory);

		let cancelled = false;
		const promise = socket.requestFullChatHistory(9, () => cancelled);
		factory.last.receive(
			frame(
				"system",
				{
					type: "chat_history_response",
					chat_id: 9,
					turns: Array.from({ length: 40 }, (_, i) => ({ turn_id: `turn_${i}`, events: [] })),
					total: 80,
					has_more: true
				},
				"evt_c1"
			)
		);
		cancelled = true;
		await expect(promise).resolves.toBeNull();
	});
});
