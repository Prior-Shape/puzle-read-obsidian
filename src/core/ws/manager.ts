import type { Logger, SocketFactory, WebSocketLike } from "../ports";
import type {
	SendChatCompletionParams,
	UserFrontEventCategory,
	WsChatHistoryResponse,
	WsChatTurn,
	WsEvent
} from "./types";

export const HEARTBEAT_INTERVAL_MS = 25000;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export const DEDUP_CACHE_SIZE = 200;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const HISTORY_PAGE_LIMIT = 40;
export const MAX_HISTORY_TURNS = 10000;

const AUTH_PROTOCOL_PREFIX = "puzle-auth-v1.";
const NO_RECONNECT_CLOSE_CODES = new Set([1000, 4001]);
const WS_OPEN = 1;

const RESPONSE_EVENT_TYPES: Record<string, string> = {
	chat_completion: "chat_completion_ack",
	stop_completion: "stop_completion_ack",
	chat_history: "chat_history_response",
	agent_task_history: "agent_task_history_response"
};

export type TokenProvider = () => string | null | undefined;
export type WsEventListener = (event: WsEvent) => void;
export type Unsubscribe = () => void;

export interface PuzleSocketOptions {
	logger?: Logger;
	heartbeatIntervalMs?: number;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
	requestTimeoutMs?: number;
	random?: () => number;
}

interface NormalizedFrame {
	eventId?: string;
	category: UserFrontEventCategory;
	event: WsEvent;
}

interface PendingRequest {
	requestType: string;
	responseType: string;
	handler: WsEventListener;
	errorHandler: WsEventListener;
	timer: ReturnType<typeof setTimeout> | null;
	settled: boolean;
	settle: () => void;
	reject: (err: Error) => void;
}

export function normalizeFrame(data: unknown): NormalizedFrame | null {
	if (!data || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;
	const eventId = typeof obj.event_id === "string" ? obj.event_id : undefined;
	const inner = obj.event;
	const hasInnerType = !!inner && typeof inner === "object" && typeof (inner as WsEvent).type === "string";
	if (typeof obj.category === "string" && hasInnerType) {
		return { eventId, category: obj.category as UserFrontEventCategory, event: inner as WsEvent };
	}
	if (hasInnerType) {
		return { eventId, category: "system", event: inner as WsEvent };
	}
	if (typeof obj.type === "string") {
		return { eventId, category: "system", event: obj as WsEvent };
	}
	return null;
}

export class PuzleSocket {
	private readonly wsUrl: string | (() => string);
	private readonly tokenProvider: TokenProvider;
	private readonly factory: SocketFactory;
	private readonly logger?: Logger;
	private readonly heartbeatIntervalMs: number;
	private readonly reconnectBaseMs: number;
	private readonly reconnectMaxMs: number;
	private readonly requestTimeoutMs: number;
	private readonly random: () => number;

	private socket: WebSocketLike | null = null;
	private connectionPromise: Promise<void> | null = null;
	private resolveConnection: (() => void) | null = null;
	private rejectConnection: ((err: Error) => void) | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private disposed = false;
	private socketOpened = false;
	private messageQueue: string[] = [];
	private readonly recentEventIds: string[] = [];
	private readonly recentEventIdSet = new Set<string>();
	private readonly categoryListeners = new Map<string, Set<WsEventListener>>();
	private readonly typeListeners = new Map<string, Set<WsEventListener>>();
	private readonly connectionLostListeners = new Set<() => void>();
	private readonly pendingRequests = new Set<PendingRequest>();

	constructor(
		wsUrl: string | (() => string),
		tokenProvider: TokenProvider,
		socketFactory: SocketFactory,
		options: PuzleSocketOptions = {}
	) {
		this.wsUrl = wsUrl;
		this.tokenProvider = tokenProvider;
		this.factory = socketFactory;
		this.logger = options.logger;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
		this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
		this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.random = options.random ?? Math.random;
	}

	get isConnected(): boolean {
		return this.socket !== null && this.socket.readyState === WS_OPEN;
	}

	connect(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error("PuzleSocket is disposed; create a new instance"));
		}
		if (this.isConnected) return Promise.resolve();
		if (this.connectionPromise) return this.connectionPromise;
		this.clearReconnectTimer();
		this.connectionPromise = new Promise<void>((resolve, reject) => {
			this.resolveConnection = resolve;
			this.rejectConnection = reject;
		});
		this.openSocket();
		return this.connectionPromise;
	}

	disconnect(): void {
		this.disposed = true;
		this.teardown(new Error("PuzleSocket disconnected"));
	}

	/**
	 * Tears down the current connection (dropping queued messages) without
	 * disposing the instance, so credential/URL providers are re-read on the
	 * next connect. Used after settings changes.
	 */
	refresh(): void {
		if (this.disposed) return;
		this.teardown(new Error("PuzleSocket refreshed"));
	}

	on(category: UserFrontEventCategory, listener: WsEventListener): Unsubscribe {
		return this.addListener(this.categoryListeners, category, listener);
	}

	/** Fires whenever an established connection (or its queued messages) is lost. */
	onConnectionLost(listener: () => void): Unsubscribe {
		this.connectionLostListeners.add(listener);
		return () => {
			this.connectionLostListeners.delete(listener);
		};
	}

	onType(type: string, listener: WsEventListener): Unsubscribe {
		return this.addListener(this.typeListeners, type, listener);
	}

	send(data: Record<string, unknown>): void {
		if (this.disposed) {
			this.logger?.warn("[ws] send after disconnect dropped", data);
			return;
		}
		const message = JSON.stringify(data);
		if (this.socket && this.socket.readyState === WS_OPEN) {
			this.socket.send(message);
			return;
		}
		this.messageQueue.push(message);
		if (!this.connectionPromise) {
			this.connect().catch((err) => this.logger?.error("[ws] auto-connect failed", err));
		}
	}

	request<T = WsEvent>(
		type: string,
		payload: Record<string, unknown> = {},
		match?: (event: WsEvent) => boolean,
		timeoutMs: number = this.requestTimeoutMs
	): Promise<T> {
		const responseType = RESPONSE_EVENT_TYPES[type] ?? `${type}_response`;
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				requestType: type,
				responseType,
				handler: () => undefined,
				errorHandler: () => undefined,
				timer: null,
				settled: false,
				settle: () => undefined,
				reject
			};
			pending.settle = () => {
				if (pending.settled) return;
				pending.settled = true;
				if (pending.timer !== null) clearTimeout(pending.timer);
				this.offType(responseType, pending.handler);
				this.offType("error", pending.errorHandler);
				this.pendingRequests.delete(pending);
			};
			pending.handler = (event) => {
				if (pending.settled) return;
				if (match && !match(event)) return;
				pending.settle();
				resolve(event as T);
			};
			pending.errorHandler = (event) => {
				if (pending.settled) return;
				const request = event.request as { type?: unknown } | undefined;
				if (request && typeof request.type === "string" && request.type !== type) return;
				pending.settle();
				const message = typeof event.message === "string" && event.message ? event.message : "WebSocket error";
				reject(new Error(message));
			};
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					if (pending.settled) return;
					pending.settle();
					reject(new Error(`WebSocket request timed out: ${type}`));
				}, timeoutMs);
			}
			this.pendingRequests.add(pending);
			this.onType(responseType, pending.handler);
			this.onType("error", pending.errorHandler);
			this.send({ type, ...payload });
		});
	}

	sendChatCompletion(params: SendChatCompletionParams): void {
		const payload: Record<string, unknown> = {
			type: "chat_completion",
			chat_id: params.chat_id ?? null,
			content: params.content
		};
		if (params.context !== undefined) payload.context = params.context;
		if (params.client_request_id !== undefined) payload.client_request_id = params.client_request_id;
		this.send(payload);
	}

	stopCompletion(chatId: number): void {
		this.send({ type: "stop_completion", chat_id: chatId });
	}

	requestChatHistory(chatId: number, offset = 0, limit = 20): Promise<WsChatHistoryResponse> {
		return this.request<WsChatHistoryResponse>(
			"chat_history",
			{ chat_id: chatId, offset, limit },
			(event) => matchChatHistoryResponse(event, chatId)
		);
	}

	async requestFullChatHistory(
		chatId: number,
		isCancelled?: () => boolean,
		initial?: WsChatHistoryResponse
	): Promise<WsChatHistoryResponse | null> {
		let offset = 0;
		let allTurns: WsChatTurn[] = [];
		let last: WsChatHistoryResponse | null = null;
		// A caller that already fetched page 0 (offset 0, HISTORY_PAGE_LIMIT) can
		// pass it as `initial` to avoid re-requesting it.
		let pending: WsChatHistoryResponse | undefined = initial;
		for (;;) {
			if (isCancelled?.()) return null;
			const res = pending ?? (await this.requestChatHistory(chatId, offset, HISTORY_PAGE_LIMIT));
			pending = undefined;
			if (isCancelled?.()) return null;
			const turns = res.turns ?? [];
			allTurns = allTurns.concat(turns);
			last = res;
			if (!res.has_more) break;
			// An empty page with has_more=true would never advance the offset.
			if (turns.length === 0) break;
			offset += turns.length;
			if (offset >= MAX_HISTORY_TURNS) break;
		}
		if (!last) return null;
		return { ...last, turns: allTurns };
	}

	private teardown(reason: Error): void {
		this.clearReconnectTimer();
		this.stopHeartbeat();
		const hadConnection = this.socket !== null || this.messageQueue.length > 0;
		this.failPendingRequests(reason);
		this.failConnection(reason);
		this.detachSocket();
		this.messageQueue = [];
		this.reconnectAttempts = 0;
		if (hadConnection) this.notifyConnectionLost();
	}

	private notifyConnectionLost(): void {
		for (const listener of [...this.connectionLostListeners]) {
			try {
				listener();
			} catch (err) {
				this.logger?.error("[ws] connection-lost listener error", err);
			}
		}
	}

	private openSocket(): void {
		this.detachSocket();
		this.socketOpened = false;
		const token = this.tokenProvider();
		const protocols = token ? [AUTH_PROTOCOL_PREFIX + token] : undefined;
		const url = typeof this.wsUrl === "function" ? this.wsUrl() : this.wsUrl;
		let socket: WebSocketLike;
		try {
			socket = this.factory.create(url, protocols);
		} catch (err) {
			this.failConnection(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		this.socket = socket;
		socket.onopen = () => this.handleOpen();
		socket.onclose = (ev) => this.handleClose(ev);
		socket.onerror = () => this.handleError();
		socket.onmessage = (ev) => this.handleMessage(ev);
	}

	private detachSocket(): void {
		const socket = this.socket;
		this.socket = null;
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close(1000);
		} catch {
			/* ignore */
		}
	}

	private handleOpen(): void {
		this.socketOpened = true;
		this.reconnectAttempts = 0;
		this.clearReconnectTimer();
		this.startHeartbeat();
		this.flushQueue();
		const resolve = this.resolveConnection;
		this.resolveConnection = null;
		this.rejectConnection = null;
		resolve?.();
	}

	private handleClose(ev: { code?: number; reason?: string } | undefined): void {
		const code = ev?.code;
		const wasOpen = this.socketOpened;
		this.socketOpened = false;
		this.stopHeartbeat();
		this.socket = null;
		this.failPendingRequests(new Error(`WebSocket closed${typeof code === "number" ? `: ${code}` : ""}`));
		if (typeof code === "number" && NO_RECONNECT_CLOSE_CODES.has(code)) {
			this.clearReconnectTimer();
			this.messageQueue = [];
			this.failConnection(
				code === 4001 ? new Error("Authentication failed") : new Error("WebSocket closed: 1000")
			);
			this.notifyConnectionLost();
			return;
		}
		this.failConnection(new Error(`WebSocket closed: ${code ?? "unknown"}`));
		this.scheduleReconnect();
		// A drop before the socket ever opened keeps the outbound queue for the
		// next attempt, so only an established connection counts as "lost".
		if (wasOpen) this.notifyConnectionLost();
	}

	private handleError(): void {
		if (this.rejectConnection) {
			const reject = this.rejectConnection;
			this.resolveConnection = null;
			this.rejectConnection = null;
			this.connectionPromise = null;
			reject(new Error("WebSocket error"));
		}
		this.scheduleReconnect();
	}

	private handleMessage(ev: { data?: unknown } | undefined): void {
		const raw = ev?.data;
		if (typeof raw !== "string") return;
		if (raw === "pong") return;
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}
		const frame = normalizeFrame(data);
		if (!frame) return;
		if (frame.eventId && this.isDuplicate(frame.eventId)) return;
		this.dispatch(frame.category, frame.event);
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer !== null) return;
		const delay = this.reconnectDelay(this.reconnectAttempts);
		this.reconnectAttempts += 1;
		this.logger?.debug(`[ws] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.disposed || this.isConnected || this.connectionPromise) return;
			this.connectionPromise = new Promise<void>((resolve, reject) => {
				this.resolveConnection = resolve;
				this.rejectConnection = reject;
			});
			this.connectionPromise.catch(() => undefined);
			this.openSocket();
		}, delay);
	}

	private reconnectDelay(attempts: number): number {
		const exponential = Math.min(this.reconnectBaseMs * 2 ** attempts, this.reconnectMaxMs);
		const jitter = Math.floor(this.random() * this.reconnectBaseMs);
		return Math.min(exponential + jitter, this.reconnectMaxMs);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (this.socket && this.socket.readyState === WS_OPEN) {
				try {
					this.socket.send("ping");
				} catch (err) {
					this.logger?.warn("[ws] heartbeat send failed", err);
				}
			}
		}, this.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private isDuplicate(eventId: string): boolean {
		if (this.recentEventIdSet.has(eventId)) return true;
		this.recentEventIds.push(eventId);
		this.recentEventIdSet.add(eventId);
		if (this.recentEventIds.length > DEDUP_CACHE_SIZE) {
			const evicted = this.recentEventIds.shift();
			if (evicted !== undefined) this.recentEventIdSet.delete(evicted);
		}
		return false;
	}

	private dispatch(category: string, event: WsEvent): void {
		const categorySet = this.categoryListeners.get(category);
		if (categorySet) {
			for (const listener of [...categorySet]) {
				try {
					listener(event);
				} catch (err) {
					this.logger?.error("[ws] listener error", category, err);
				}
			}
		}
		const typeSet = this.typeListeners.get(event.type);
		if (typeSet) {
			for (const listener of [...typeSet]) {
				try {
					listener(event);
				} catch (err) {
					this.logger?.error("[ws] type listener error", event.type, err);
				}
			}
		}
	}

	private addListener(
		map: Map<string, Set<WsEventListener>>,
		key: string,
		listener: WsEventListener
	): Unsubscribe {
		let set = map.get(key);
		if (!set) {
			set = new Set();
			map.set(key, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) map.delete(key);
		};
	}

	private offType(type: string, listener: WsEventListener): void {
		const set = this.typeListeners.get(type);
		if (!set) return;
		set.delete(listener);
		if (set.size === 0) this.typeListeners.delete(type);
	}

	private flushQueue(): void {
		if (this.messageQueue.length === 0) return;
		const queue = this.messageQueue;
		this.messageQueue = [];
		for (const message of queue) {
			this.socket?.send(message);
		}
	}

	private failConnection(err: Error): void {
		const reject = this.rejectConnection;
		this.resolveConnection = null;
		this.rejectConnection = null;
		this.connectionPromise = null;
		reject?.(err);
	}

	private failPendingRequests(err: Error): void {
		for (const pending of [...this.pendingRequests]) {
			pending.settle();
			pending.settled = true;
			pending.reject(err);
		}
	}
}

function matchChatHistoryResponse(event: WsEvent, chatId: number): boolean {
	const response = event as unknown as { chat_id?: unknown; request?: { chat_id?: unknown } };
	if (response.chat_id !== chatId) return false;
	const requestChatId = response.request?.chat_id;
	return requestChatId === undefined || requestChatId === chatId;
}
