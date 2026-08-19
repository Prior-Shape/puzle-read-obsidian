// Puzle 后端的本地 mock：REST + WebSocket，按 docs/research/backend-api.md 还原协议。
// 零依赖（手写 WS 握手与帧编解码），并暴露 /__control 用于在测试中注入异常场景。

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VALID_TOKEN = "e2e-valid-token";

// ---------------------------------------------------------------- 数据夹具

const state = {
	// 控制开关，供测试注入异常
	control: {
		authMode: "ok", // ok | reject401 | wsReject4001
		historyEmptyPageLoop: false, // 让 chat_history 返回 has_more=true 且 turns=[]
		streamMode: "normal", // normal | dropMidStream | slow
		titleGenerated: true
	},
	requests: [], // REST 请求日志
	wsFrames: [], // 收到的 WS 帧日志
	sockets: new Set(),
	nextChatId: 900,
	articles: makeArticles(),
	chats: makeChats()
};

function makeArticles() {
	return [
		{
			id: 101,
			task_id: 1010,
			resource_type: "link",
			resource_id: 101,
			chat_id: 501,
			created_time: "2026-08-01T10:00:00Z",
			last_comment_at: "2026-08-02T11:00:00Z",
			highlight_count: 2,
			comment_count: 2,
			title: "如何阅读一本书",
			url: "https://example.com/how-to-read",
			status: "done",
			puzle_id: 1727,
			domain: "example.com",
			author: "莫提默·艾德勒",
			topics: [{ id: 1, title: "阅读方法" }],
			content: [
				"# 如何阅读一本书",
				"",
				"阅读可以分为四个层次，每一层都建立在前一层之上。",
				"",
				"基础阅读解决的是识字问题，检视阅读解决的是在有限时间内抓住全书骨架的问题。",
				"",
				"分析阅读要求读者与作者达成共识，主题阅读则是围绕一个问题读很多本书。"
			].join("\n")
		},
		{
			id: 102,
			task_id: 1020,
			resource_type: "file",
			resource_id: 102,
			chat_id: null,
			created_time: "2026-08-03T09:00:00Z",
			highlight_count: 0,
			comment_count: 0,
			title: "深度工作 摘录.pdf",
			status: "viewed",
			puzle_id: 1728,
			domain: "",
			file_name: "深度工作 摘录.pdf",
			content: "深度工作是在无干扰状态下专注进行的职业活动。"
		},
		{
			// 不可同步：状态未完成，应被 isSyncableArticle 过滤
			id: 103,
			task_id: 1030,
			resource_type: "link",
			resource_id: 103,
			chat_id: null,
			created_time: "2026-08-04T09:00:00Z",
			highlight_count: 0,
			comment_count: 0,
			title: "还在解析中的文章",
			status: "parsing",
			puzle_id: 1729,
			domain: "example.com",
			content: ""
		}
	];
}

function makeChats() {
	return [
		{
			id: 201,
			task_id: 2010,
			resource_type: "chat",
			resource_id: 201,
			chat_id: 214,
			created_time: "2026-08-05T12:00:00Z",
			highlight_count: 0,
			title: "关于阅读层次的讨论",
			status: "done",
			puzle_id: 1730,
			domain: "",
			turns: [
				{
					turn_id: "turn_1",
					events: [
						{ type: "message", role: "user", detail: [{ type: "text", text: "阅读有几个层次？" }] },
						{
							type: "message",
							role: "assistant",
							detail: { type: "text", marker: "full", text: "共四个层次：基础、检视、分析、主题。" }
						},
						{ type: "log", log: { type: "thinking", reasoning: "回忆《如何阅读一本书》的框架" } }
					]
				},
				{
					turn_id: "turn_2",
					events: [
						{ type: "message", role: "user", detail: [{ type: "text", text: "检视阅读怎么做？" }] },
						{
							type: "message",
							role: "assistant",
							detail: { type: "text", marker: "full", text: "先看序言目录，再抽样翻读，控制在一小时内。" }
						}
					]
				}
			]
		}
	];
}

const HIGHLIGHTS = {
	101: [
		{
			id: 9001,
			highlight_type: "text",
			role: "user",
			category: "key_points",
			content: "阅读可以分为四个层次",
			color: "rgba(255,212,0,0.4)",
			hidden: false,
			created_at: "2026-08-02T10:30:00Z",
			location_data: { start_index: 12, end_index: 22 }
		},
		{
			id: 9002,
			highlight_type: "text",
			role: "assistant",
			category: "new_knowledge",
			content: "检视阅读解决的是在有限时间内抓住全书骨架的问题",
			color: "rgba(0,200,120,0.35)",
			hidden: false,
			created_at: "2026-08-02T10:40:00Z",
			location_data: { start_index: 60, end_index: 82 }
		}
	]
};

const COMMENTS = {
	101: [
		{
			id: 7001,
			content: "这个分层框架很实用。",
			role: "user",
			created_at: "2026-08-02T11:00:00Z",
			highlight_id: null
		},
		{
			id: 7002,
			content: "可以对照《如何阅读一本书》第二篇。",
			role: "assistant",
			created_at: "2026-08-02T11:05:00Z",
			highlight_id: 9001
		}
	]
};

const SUMMARY = {
	101: {
		key_points: ["阅读分为四个层次", "层次之间是累进关系"],
		new_knowledge: ["检视阅读强调时间约束"],
		different_opinions: [],
		related_information: ["与《深度工作》的专注理念互补"]
	}
};

// ---------------------------------------------------------------- HTTP

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

const ok = (data) => ({ code: 0, data, msg: null });

function paginate(items, query) {
	const page = Number(query.get("page") ?? 1);
	const pageSize = Number(query.get("page_size") ?? 50);
	const start = (page - 1) * pageSize;
	return {
		items: items.slice(start, start + pageSize),
		total: items.length,
		page,
		page_size: pageSize
	};
}

function listItemView(entry) {
	const { content, turns, file_name, ...rest } = entry;
	void content;
	void turns;
	void file_name;
	return rest;
}

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const path = url.pathname;
	const auth = req.headers.authorization ?? "";

	// 控制面：供测试注入场景 / 读取请求日志
	if (path === "/__control") {
		if (req.method === "POST") {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				try {
					Object.assign(state.control, JSON.parse(raw || "{}"));
				} catch {
					/* ignore */
				}
				sendJson(res, 200, { control: state.control });
			});
			return;
		}
		return sendJson(res, 200, {
			control: state.control,
			requests: state.requests,
			wsFrames: state.wsFrames,
			openSockets: state.sockets.size
		});
	}
	if (path === "/__reset") {
		state.requests = [];
		state.wsFrames = [];
		state.control = {
			authMode: "ok",
			historyEmptyPageLoop: false,
			streamMode: "normal",
			titleGenerated: true
		};
		state.articles = makeArticles();
		state.chats = makeChats();
		return sendJson(res, 200, { ok: true });
	}
	if (path === "/__drop-sockets") {
		for (const s of state.sockets) s.dropNow();
		return sendJson(res, 200, { dropped: true });
	}

	state.requests.push({ method: req.method, path, query: url.search, at: Date.now() });

	if (!path.startsWith("/api/v1/")) return sendJson(res, 404, { code: 404, msg: "not found" });

	// 认证
	if (state.control.authMode === "reject401" || !auth.startsWith("Bearer ")) {
		return sendJson(res, 401, { code: 401, data: null, msg: "unauthorized" });
	}
	if (auth !== `Bearer ${VALID_TOKEN}`) {
		return sendJson(res, 200, { code: 401001, data: null, msg: "token 已失效" });
	}

	if (path === "/api/v1/users/profile") {
		return sendJson(res, 200, ok({ id: 1, username: "e2e-tester", logged: true, onboarded: true }));
	}
	if (path === "/api/v1/topics") {
		return sendJson(res, 200, ok([{ id: 1, title: "阅读方法", note_count: 2, reading_count: 1 }]));
	}
	if (path === "/api/v1/reading/items") {
		const all = [...state.articles, ...state.chats].map(listItemView);
		return sendJson(res, 200, ok(paginate(all, url.searchParams)));
	}
	let m = path.match(/^\/api\/v1\/reading\/link\/(\d+)$/);
	if (m) {
		const entry = state.articles.find((a) => a.id === Number(m[1]));
		if (!entry) return sendJson(res, 200, { code: 404001, data: null, msg: "not found" });
		return sendJson(res, 200, ok({ ...listItemView(entry), content: entry.content }));
	}
	m = path.match(/^\/api\/v1\/reading\/link\/(\d+)\/summary$/);
	if (m) {
		const summary = SUMMARY[Number(m[1])];
		if (!summary) return sendJson(res, 200, { code: 404001, data: null, msg: "no summary" });
		return sendJson(res, 200, ok(summary));
	}
	m = path.match(/^\/api\/v1\/reading\/file\/(\d+)$/);
	if (m) {
		const entry = state.articles.find((a) => a.id === Number(m[1]));
		if (!entry) return sendJson(res, 200, { code: 404001, data: null, msg: "not found" });
		return sendJson(
			res,
			200,
			ok({ ...listItemView(entry), content: entry.content, file_name: entry.file_name })
		);
	}
	if (path === "/api/v1/reading/highlights") {
		const readingId = Number(url.searchParams.get("reading_id"));
		return sendJson(res, 200, ok(paginate(HIGHLIGHTS[readingId] ?? [], url.searchParams)));
	}
	if (path === "/api/v1/reading/comments") {
		const readingId = Number(url.searchParams.get("reading_id"));
		return sendJson(res, 200, ok(paginate(COMMENTS[readingId] ?? [], url.searchParams)));
	}
	return sendJson(res, 200, { code: 0, data: null, msg: null });
});

// ---------------------------------------------------------------- WebSocket

function encodeFrame(payload, opcode = 0x1) {
	const data = Buffer.from(payload, "utf8");
	const len = data.length;
	let header;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = len;
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = 0x80 | opcode;
	return Buffer.concat([header, data]);
}

function encodeClose(code) {
	const body = Buffer.alloc(2);
	body.writeUInt16BE(code, 0);
	const header = Buffer.alloc(2);
	header[0] = 0x88;
	header[1] = body.length;
	return Buffer.concat([header, body]);
}

class WsConnection {
	constructor(socket) {
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.closed = false;
		this.activeStreams = new Map();
		state.sockets.add(this);
		socket.on("data", (chunk) => this.#onData(chunk));
		socket.on("close", () => {
			this.closed = true;
			state.sockets.delete(this);
		});
		socket.on("error", () => {
			this.closed = true;
			state.sockets.delete(this);
		});
	}

	send(text) {
		if (this.closed) return;
		this.socket.write(encodeFrame(text));
	}

	sendEvent(category, event) {
		this.send(JSON.stringify({ event_id: `evt_${randomUUID()}`, category, timestamp: new Date().toISOString(), user_id: 1, event }));
	}

	closeWith(code) {
		if (this.closed) return;
		this.socket.write(encodeClose(code));
		this.socket.end();
		this.closed = true;
	}

	/** 直接断开底层 TCP，模拟网络中断（不发 close 帧）。 */
	dropNow() {
		if (this.closed) return;
		this.socket.destroy();
		this.closed = true;
		state.sockets.delete(this);
	}

	#onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const frame = this.#decodeFrame();
			if (!frame) break;
			if (frame.opcode === 0x8) {
				this.closeWith(1000);
				break;
			}
			if (frame.opcode === 0x1) this.#onText(frame.payload);
		}
	}

	#decodeFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (buf.length < offset + 2) return null;
			len = buf.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (buf.length < offset + 8) return null;
			len = Number(buf.readBigUInt64BE(offset));
			offset += 8;
		}
		let maskKey;
		if (masked) {
			if (buf.length < offset + 4) return null;
			maskKey = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + len) return null;
		const payload = Buffer.from(buf.subarray(offset, offset + len));
		if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
		this.buffer = buf.subarray(offset + len);
		return { opcode, payload: payload.toString("utf8") };
	}

	#onText(text) {
		if (text === "ping") {
			state.wsFrames.push({ dir: "in", raw: "ping", at: Date.now() });
			this.send("pong");
			return;
		}
		let msg;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		state.wsFrames.push({ dir: "in", msg, at: Date.now() });
		switch (msg.type) {
			case "chat_history":
				return this.#handleChatHistory(msg);
			case "chat_completion":
				return this.#handleCompletion(msg);
			case "stop_completion":
				return this.#handleStop(msg);
			default:
				this.sendEvent("system", { type: "error", message: `unknown type ${msg.type}`, request: msg });
		}
	}

	#handleChatHistory(msg) {
		const chat = state.chats.find((c) => c.chat_id === msg.chat_id);
		if (state.control.historyEmptyPageLoop) {
			// 异常场景：声称还有更多但返回空页（旧实现会死循环）
			return this.sendEvent("system", {
				type: "chat_history_response",
				chat_id: msg.chat_id,
				title: chat?.title ?? null,
				total: 999,
				has_more: true,
				turns: [],
				request: msg
			});
		}
		if (!chat) {
			return this.sendEvent("system", {
				type: "chat_history_response",
				chat_id: msg.chat_id,
				title: null,
				total: 0,
				has_more: false,
				turns: [],
				request: msg
			});
		}
		const offset = msg.offset ?? 0;
		const limit = msg.limit ?? 20;
		const slice = chat.turns.slice(offset, offset + limit);
		this.sendEvent("system", {
			type: "chat_history_response",
			chat_id: chat.chat_id,
			puzle_id: chat.puzle_id,
			title: chat.title,
			total: chat.turns.length,
			has_more: offset + slice.length < chat.turns.length,
			turns: slice,
			request: msg
		});
	}

	#handleCompletion(msg) {
		const isNew = msg.chat_id === null || msg.chat_id === undefined;
		const chatId = isNew ? ++state.nextChatId : msg.chat_id;
		const turnId = `turn_${randomUUID().slice(0, 8)}`;

		this.sendEvent("system", {
			type: "chat_completion_ack",
			chat_id: chatId,
			puzle_id: 9999,
			request: msg
		});
		this.sendEvent("chat", { type: "turn_start", chat_id: chatId, turn_id: turnId });

		const contentText =
			typeof msg.content === "string"
				? msg.content
				: (msg.content ?? []).map((p) => p.text ?? "").join("");
		const reply = `收到：${contentText.slice(0, 20)}。这是 mock 后端的流式回复。`;

		const chunks = splitForStream(reply);
		const stream = { chatId, turnId, cancelled: false, timers: [] };
		this.activeStreams.set(chatId, stream);

		const stepMs = state.control.streamMode === "slow" ? 400 : 60;
		chunks.forEach((chunk, i) => {
			const t = setTimeout(() => {
				if (stream.cancelled || this.closed) return;
				if (state.control.streamMode === "dropMidStream" && i === Math.floor(chunks.length / 2)) {
					this.dropNow();
					return;
				}
				this.sendEvent("chat", {
					type: "message",
					chat_id: chatId,
					turn_id: turnId,
					role: "assistant",
					detail: { type: "text", marker: i === 0 ? "started" : "delta", delta: chunk }
				});
			}, stepMs * (i + 1));
			stream.timers.push(t);
		});

		const endAt = stepMs * (chunks.length + 1);
		if (isNew && state.control.titleGenerated) {
			stream.timers.push(
				setTimeout(() => {
					if (stream.cancelled || this.closed) return;
					this.sendEvent("chat", {
						type: "title_generated",
						chat_id: chatId,
						turn_id: turnId,
						title: "Mock 生成的标题"
					});
				}, endAt)
			);
		}
		stream.timers.push(
			setTimeout(() => {
				if (stream.cancelled || this.closed) return;
				this.sendEvent("chat", {
					type: "message",
					chat_id: chatId,
					turn_id: turnId,
					role: "assistant",
					detail: { type: "text", marker: "completed", text: reply }
				});
				this.sendEvent("chat", {
					type: "turn_end",
					chat_id: chatId,
					turn_id: turnId,
					status: "ok",
					error: null
				});
				this.activeStreams.delete(chatId);
				// 新会话产生后加入列表，供会话列表刷新验证
				if (isNew && !state.chats.some((c) => c.chat_id === chatId)) {
					state.chats.push({
						id: 300 + chatId,
						task_id: 3000 + chatId,
						resource_type: "chat",
						resource_id: 300 + chatId,
						chat_id: chatId,
						created_time: new Date().toISOString(),
						highlight_count: 0,
						title: "Mock 生成的标题",
						status: "done",
						puzle_id: 9999,
						domain: "",
						turns: [
							{
								turn_id: turnId,
								events: [
									{ type: "message", role: "user", detail: [{ type: "text", text: contentText }] },
									{
										type: "message",
										role: "assistant",
										detail: { type: "text", marker: "full", text: reply }
									}
								]
							}
						]
					});
				}
			}, endAt + stepMs)
		);
	}

	#handleStop(msg) {
		const stream = this.activeStreams.get(msg.chat_id);
		if (stream) {
			stream.cancelled = true;
			for (const t of stream.timers) clearTimeout(t);
			this.activeStreams.delete(msg.chat_id);
		}
		this.sendEvent("system", { type: "stop_completion_ack", chat_id: msg.chat_id, stopped: !!stream, request: msg });
		if (stream) {
			this.sendEvent("chat", {
				type: "turn_end",
				chat_id: msg.chat_id,
				turn_id: stream.turnId,
				status: "cancelled",
				error: null
			});
		}
	}
}

function splitForStream(text) {
	const out = [];
	for (let i = 0; i < text.length; i += 6) out.push(text.slice(i, i + 6));
	return out;
}

server.on("upgrade", (req, socket) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	if (url.pathname !== "/api/v1/agent/events") {
		socket.destroy();
		return;
	}
	const key = req.headers["sec-websocket-key"];
	const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const authProto = protocols.find((p) => p.startsWith("puzle-auth-v1."));
	const token = authProto ? authProto.slice("puzle-auth-v1.".length) : null;

	const accept = createHash("sha1").update(key + WS_MAGIC).digest("base64");
	const headers = [
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`
	];
	if (authProto) headers.push(`Sec-WebSocket-Protocol: ${authProto}`);
	socket.write(headers.join("\r\n") + "\r\n\r\n");

	const conn = new WsConnection(socket);
	state.wsFrames.push({ dir: "meta", event: "connected", token: token ? `${token.slice(0, 12)}…` : null, at: Date.now() });

	if (state.control.authMode === "wsReject4001" || token !== VALID_TOKEN) {
		setTimeout(() => conn.closeWith(4001), 10);
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[mock] listening on http://127.0.0.1:${PORT}  (token: ${VALID_TOKEN})`);
});
