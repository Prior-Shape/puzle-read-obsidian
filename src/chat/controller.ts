import type { PuzleClient } from "../core/api/client";
import { isChatReadingItem, resolveChatId } from "../core/models";
import type { Logger } from "../core/ports";
import type { ChatMessage } from "../core/ws/history";
import { mapChatHistoryResponse } from "../core/ws/history";
import type { PuzleSocket, Unsubscribe } from "../core/ws/manager";
import type { TurnStreamState } from "../core/ws/stream";
import { TurnStreamReducer } from "../core/ws/stream";
import type { ChatStreamEvent, WsEvent } from "../core/ws/types";

export interface ChatSessionInfo {
	chatId: number;
	title: string;
	status?: string | null;
	createdTime?: string | null;
}

export interface ActiveChatState {
	chatId: number | null;
	title: string | null;
	messages: ChatMessage[];
	streaming: boolean;
	loading: boolean;
	error: string | null;
}

export interface ChatControllerState {
	sessions: ChatSessionInfo[];
	active: ActiveChatState;
}

export interface ChatControllerOptions {
	logger?: Logger;
}

export type ChatStateListener = (state: ChatControllerState) => void;

const STREAMING_ID_PREFIX = "streaming-";

function createEmptyActive(): ActiveChatState {
	return {
		chatId: null,
		title: null,
		messages: [],
		streaming: false,
		loading: false,
		error: null
	};
}

function createInitialState(): ChatControllerState {
	return { sessions: [], active: createEmptyActive() };
}

function isStreamingMessage(message: ChatMessage | undefined): boolean {
	return !!message && message.role === "assistant" && message.id.startsWith(STREAMING_ID_PREFIX);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class ChatController {
	private readonly socket: PuzleSocket;
	private readonly clientSource: PuzleClient | (() => PuzleClient);
	private readonly options: ChatControllerOptions;
	private readonly listeners = new Set<ChatStateListener>();
	private readonly reducer = new TurnStreamReducer();
	private readonly unsubscribers: Unsubscribe[] = [];
	private state: ChatControllerState = createInitialState();
	private generation = 0;
	private sessionLoadGeneration = 0;
	private streamChatId: number | null = null;
	private requestId = "";
	private disposed = false;

	constructor(
		socket: PuzleSocket,
		client: PuzleClient | (() => PuzleClient),
		options: ChatControllerOptions = {}
	) {
		this.socket = socket;
		this.clientSource = client;
		this.options = options;
		this.unsubscribers.push(
			socket.onType("chat_completion_ack", (event) => this.handleAck(event)),
			socket.on("chat", (event) => this.handleChatEvent(event as ChatStreamEvent)),
			socket.onConnectionLost(() => this.handleConnectionLost())
		);
	}

	private get client(): PuzleClient {
		return typeof this.clientSource === "function" ? this.clientSource() : this.clientSource;
	}

	getState(): ChatControllerState {
		return this.state;
	}

	subscribe(listener: ChatStateListener): Unsubscribe {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async loadSessions(): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.sessionLoadGeneration;
		try {
			const sessions: ChatSessionInfo[] = [];
			for await (const item of this.client.iterateAllReadingItems()) {
				if (this.disposed || generation !== this.sessionLoadGeneration) return;
				if (!isChatReadingItem(item)) continue;
				const chatId = resolveChatId(item);
				if (chatId === null) continue;
				sessions.push({
					chatId,
					title: item.title?.trim() || `对话 ${chatId}`,
					status: item.status ?? null,
					createdTime: item.created_time ?? null
				});
			}
			if (this.disposed || generation !== this.sessionLoadGeneration) return;
			this.setState({ sessions });
		} catch (err) {
			if (this.disposed || generation !== this.sessionLoadGeneration) return;
			this.options.logger?.error("[chat] 加载会话列表失败", err);
		}
	}

	async openSession(chatId: number): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		this.streamChatId = null;
		this.reducer.reset();
		const session = this.state.sessions.find((entry) => entry.chatId === chatId);
		this.setState({
			active: {
				chatId,
				title: session?.title ?? null,
				messages: [],
				streaming: false,
				loading: true,
				error: null
			}
		});
		try {
			const response = await this.socket.requestFullChatHistory(
				chatId,
				() => this.disposed || generation !== this.generation
			);
			if (this.disposed || generation !== this.generation || this.state.active.chatId !== chatId) return;
			if (!response) return;
			const title = response.title?.trim() || this.state.active.title;
			this.setState({
				active: {
					...this.state.active,
					messages: mapChatHistoryResponse(response),
					title,
					loading: false
				}
			});
		} catch (err) {
			if (this.disposed || generation !== this.generation || this.state.active.chatId !== chatId) return;
			this.options.logger?.error("[chat] 加载对话历史失败", err);
			this.setState({
				active: { ...this.state.active, loading: false, error: errorMessage(err) }
			});
		}
	}

	newSession(): void {
		if (this.disposed) return;
		this.generation += 1;
		this.streamChatId = null;
		this.reducer.reset();
		this.setState({ active: createEmptyActive() });
	}

	send(text: string): void {
		if (this.disposed) return;
		const content = text.trim();
		if (!content) return;
		const active = this.state.active;
		if (active.streaming || active.loading) return;
		this.generation += 1;
		this.reducer.reset();
		this.streamChatId = active.chatId;
		this.requestId = `puzle-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const userMessage: ChatMessage = {
			id: `user-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			role: "user",
			content,
			turnId: ""
		};
		this.setState({
			active: {
				...active,
				messages: [...active.messages, userMessage],
				streaming: true,
				error: null
			}
		});
		this.socket.sendChatCompletion({
			chat_id: active.chatId,
			content,
			client_request_id: this.requestId
		});
	}

	stop(): void {
		if (this.disposed) return;
		const active = this.state.active;
		if (!active.streaming) return;
		const chatId = this.streamChatId ?? active.chatId;
		if (chatId === null) return;
		this.socket.stopCompletion(chatId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers.length = 0;
		this.listeners.clear();
	}

	private setState(patch: Partial<ChatControllerState>): void {
		this.state = { ...this.state, ...patch };
		this.emit();
	}

	private emit(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(this.state);
			} catch (err) {
				this.options.logger?.error("[chat] state listener error", err);
			}
		}
	}

	private handleConnectionLost(): void {
		if (this.disposed) return;
		const active = this.state.active;
		if (!active.streaming) return;
		const messages = [...active.messages];
		const last = messages[messages.length - 1];
		if (isStreamingMessage(last)) {
			if (last.content || last.logs || last.taskOutputs) {
				messages[messages.length - 1] = { ...last, id: `assistant-interrupted-${last.turnId || Date.now()}` };
			} else {
				messages.pop();
			}
		}
		this.streamChatId = null;
		this.reducer.reset();
		this.setState({
			active: { ...active, messages, streaming: false, error: "连接已断开，本次回复中断，请重试" }
		});
	}

	private handleAck(event: WsEvent): void {
		if (this.disposed) return;
		const active = this.state.active;
		if (!active.streaming) return;
		const chatId = typeof event.chat_id === "number" ? event.chat_id : null;
		if (chatId === null) return;
		if (this.streamChatId !== null) return;
		// The ack may belong to another consumer on the shared socket (AI 续写);
		// only adopt it when the echoed client_request_id matches ours.
		const request = event.request as { client_request_id?: unknown } | undefined;
		const ackRequestId =
			request && typeof request.client_request_id === "string" ? request.client_request_id : null;
		if (ackRequestId !== null && ackRequestId !== this.requestId) return;
		this.streamChatId = chatId;
		if (active.chatId === null) {
			this.setState({ active: { ...active, chatId } });
		}
		void this.loadSessions();
	}

	private handleChatEvent(event: ChatStreamEvent): void {
		if (this.disposed) return;
		const active = this.state.active;
		if (!active.streaming) return;
		const eventChatId = typeof event.chat_id === "number" ? event.chat_id : undefined;
		if (eventChatId !== undefined) {
			if (this.streamChatId === null) {
				// Fallback when the ack is lost: only a turn_start may claim the
				// stream, so mid-stream events of another consumer's turn (AI 续写)
				// are not adopted by mistake.
				if (event.type !== "turn_start") return;
				this.adoptStreamChatId(eventChatId);
			} else if (eventChatId !== this.streamChatId) {
				return;
			}
		}
		const snapshot = this.reducer.handle(event);
		if (event.type === "turn_end") {
			this.finishTurn(snapshot, event);
			return;
		}
		if (event.type === "title_generated") {
			this.applyGeneratedTitle(snapshot.title);
		}
		this.syncStreamingMessage(snapshot);
	}

	private adoptStreamChatId(chatId: number): void {
		this.streamChatId = chatId;
		const active = this.state.active;
		if (active.chatId === null) {
			this.setState({ active: { ...active, chatId } });
		}
	}

	private applyGeneratedTitle(title: string | undefined): void {
		if (!title) return;
		const chatId = this.streamChatId ?? this.state.active.chatId;
		let sessions = this.state.sessions;
		if (chatId !== null) {
			const exists = sessions.some((entry) => entry.chatId === chatId);
			sessions = exists
				? sessions.map((entry) => (entry.chatId === chatId ? { ...entry, title } : entry))
				: [{ chatId, title, status: "thinking", createdTime: null }, ...sessions];
		}
		this.setState({ sessions, active: { ...this.state.active, title } });
	}

	private syncStreamingMessage(snapshot: TurnStreamState): void {
		const active = this.state.active;
		const messages = [...active.messages];
		const last = messages[messages.length - 1];
		const message: ChatMessage = {
			id: isStreamingMessage(last) ? last.id : `${STREAMING_ID_PREFIX}${snapshot.turnId ?? "pending"}`,
			role: "assistant",
			content: snapshot.text,
			turnId: snapshot.turnId ?? "",
			logs: snapshot.thinkingLogs.length > 0 ? snapshot.thinkingLogs : undefined,
			taskOutputs: snapshot.taskOutputs.length > 0 ? snapshot.taskOutputs : undefined
		};
		if (isStreamingMessage(last)) {
			messages[messages.length - 1] = message;
		} else {
			messages.push(message);
		}
		this.setState({ active: { ...active, messages } });
	}

	private finishTurn(snapshot: TurnStreamState, event: ChatStreamEvent): void {
		const active = this.state.active;
		const messages = [...active.messages];
		const last = messages[messages.length - 1];
		const hasContent =
			snapshot.text.length > 0 || snapshot.thinkingLogs.length > 0 || snapshot.taskOutputs.length > 0;
		if (isStreamingMessage(last)) {
			if (hasContent) {
				messages[messages.length - 1] = {
					id: `assistant-${snapshot.turnId || last.turnId || Date.now()}`,
					role: "assistant",
					content: snapshot.text,
					turnId: snapshot.turnId || last.turnId,
					logs: snapshot.thinkingLogs.length > 0 ? snapshot.thinkingLogs : undefined,
					taskOutputs: snapshot.taskOutputs.length > 0 ? snapshot.taskOutputs : undefined
				};
			} else {
				messages.pop();
			}
		}
		this.streamChatId = null;
		this.reducer.reset();
		const error =
			event.status === "error"
				? typeof event.error === "string" && event.error
					? event.error
					: "回复失败"
				: null;
		this.setState({ active: { ...active, messages, streaming: false, error } });
	}
}
