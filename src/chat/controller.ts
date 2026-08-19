import type { PuzleClient } from "../core/api/client";
import { isChatReadingItem, resolveChatId } from "../core/models";
import type { Logger } from "../core/ports";
import type { ChatMessage } from "../core/ws/history";
import { mapChatHistoryResponse } from "../core/ws/history";
import type { PuzleSocket, Unsubscribe } from "../core/ws/manager";
import type { TurnStreamState } from "../core/ws/stream";
import { TurnStreamReducer } from "../core/ws/stream";
import type { ChatContextModel, ChatStreamEvent, WsEvent } from "../core/ws/types";

export interface ChatSessionInfo {
	chatId: number;
	title: string;
}

export interface ArticleBinding {
	readingId: number;
	title: string;
	/** 文章笔记在 Vault 中的路径，用于回写 frontmatter 的 chat_id */
	path?: string | null;
}

export interface ActiveChatState {
	chatId: number | null;
	title: string | null;
	article: ArticleBinding | null;
	/** 「就这段提问」暂存的引用原文，随下一条消息作为 selected_text 发出 */
	pendingSelection: string | null;
	messages: ChatMessage[];
	streaming: boolean;
	loading: boolean;
	error: string | null;
}

export interface ChatControllerState {
	sessions: ChatSessionInfo[];
	sessionsLoading: boolean;
	active: ActiveChatState;
}

export interface ChatControllerOptions {
	logger?: Logger;
	/** 历史遗留的续写专用会话不应出现在会话列表里 */
	getExcludedChatId?: () => number | null;
	/** 新会话首次拿到 chat_id 时回调，用于把绑定持久化到文章 */
	onArticleChatBound?: (readingId: number, chatId: number) => void;
}

export type ChatStateListener = (state: ChatControllerState) => void;

const STREAMING_ID_PREFIX = "streaming-";
/** 会话列表边翻页边渲染的批次大小：账号条目多时不用等全部拉完才看到东西 */
export const SESSION_EMIT_BATCH = 10;

function createEmptyActive(
	article: ArticleBinding | null = null,
	pendingSelection: string | null = null
): ActiveChatState {
	return {
		chatId: null,
		title: null,
		article,
		pendingSelection,
		messages: [],
		streaming: false,
		loading: false,
		error: null
	};
}

function createInitialState(): ChatControllerState {
	return { sessions: [], sessionsLoading: false, active: createEmptyActive() };
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
	private sessionsLoadedOnce = false;
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

	/**
	 * 拉会话列表。条目多时 `/reading/items` 要翻很多页，所以边翻边发状态，
	 * 而不是等全部拉完 —— 否则面板长时间空白，看起来像「没有会话列表」。
	 * 已经拉过一次的，非 force 调用直接复用缓存。
	 */
	async loadSessions(force = false): Promise<void> {
		if (this.disposed) return;
		if (this.sessionsLoadedOnce && !force) return;
		const generation = ++this.sessionLoadGeneration;
		const stale = () => this.disposed || generation !== this.sessionLoadGeneration;
		this.setState({ sessionsLoading: true });
		try {
			const excluded = this.options.getExcludedChatId?.() ?? null;
			const sessions: ChatSessionInfo[] = [];
			let sinceEmit = 0;

			for await (const item of this.client.iterateAllReadingItems()) {
				if (stale()) return;
				if (!isChatReadingItem(item)) continue;
				const chatId = resolveChatId(item);
				if (chatId === null || chatId === excluded) continue;
				sessions.push({ chatId, title: item.title?.trim() || `对话 ${chatId}` });
				sinceEmit += 1;
				if (sinceEmit >= SESSION_EMIT_BATCH) {
					sinceEmit = 0;
					this.setState({ sessions: [...sessions] });
				}
			}
			if (stale()) return;
			this.sessionsLoadedOnce = true;
			this.setState({ sessions: [...sessions], sessionsLoading: false });
		} catch (err) {
			if (stale()) return;
			this.options.logger?.error("[chat] 加载会话列表失败", err);
			this.setState({ sessionsLoading: false });
		}
	}

	async openSession(chatId: number, article: ArticleBinding | null = null): Promise<void> {
		if (this.disposed) return;
		const generation = ++this.generation;
		this.streamChatId = null;
		this.reducer.reset();
		const session = this.state.sessions.find((entry) => entry.chatId === chatId);
		this.setState({
			active: {
				chatId,
				title: session?.title ?? null,
				article,
				pendingSelection: null,
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

	/**
	 * 打开某篇文章的对话。一篇文章只有一个会话：已有 chat_id 就继续它，
	 * 没有才开新的，并在 ack 回来时把 chat_id 绑回文章。
	 */
	async openArticleChat(
		article: ArticleBinding,
		chatId: number | null,
		selectedText?: string
	): Promise<void> {
		if (this.disposed) return;
		const selection = selectedText?.trim() || null;
		if (chatId !== null) {
			await this.openSession(chatId, article);
			if (selection) this.setPendingSelection(selection);
			return;
		}
		this.generation += 1;
		this.streamChatId = null;
		this.reducer.reset();
		this.setState({ active: createEmptyActive(article, selection) });
	}

	setPendingSelection(selectedText: string | null): void {
		if (this.disposed) return;
		const selection = selectedText?.trim() || null;
		this.setState({ active: { ...this.state.active, pendingSelection: selection } });
	}

	send(text: string, selectedText?: string): void {
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
		const selection = selectedText ?? active.pendingSelection ?? undefined;
		this.setState({
			active: {
				...active,
				messages: [...active.messages, userMessage],
				pendingSelection: null,
				streaming: true,
				error: null
			}
		});
		this.socket.sendChatCompletion({
			chat_id: active.chatId,
			content,
			context: buildReadingContext(active.article, selection),
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
		// The ack may belong to another consumer on the shared socket;
		// only adopt it when the echoed client_request_id matches ours.
		const request = event.request as { client_request_id?: unknown } | undefined;
		const ackRequestId =
			request && typeof request.client_request_id === "string" ? request.client_request_id : null;
		if (ackRequestId !== null && ackRequestId !== this.requestId) return;
		this.streamChatId = chatId;
		if (active.chatId === null) {
			this.bindNewChatId(chatId);
		}
		void this.loadSessions(true);
	}

	private handleChatEvent(event: ChatStreamEvent): void {
		if (this.disposed) return;
		const active = this.state.active;
		if (!active.streaming) return;
		const eventChatId = typeof event.chat_id === "number" ? event.chat_id : undefined;
		if (eventChatId !== undefined) {
			if (this.streamChatId === null) {
				// Fallback when the ack is lost: only a turn_start may claim the
				// stream, so mid-stream events of another consumer's turn are not
				// adopted by mistake.
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
		if (this.state.active.chatId === null) {
			this.bindNewChatId(chatId);
		}
	}

	/** 新会话第一次拿到 chat_id：写进 active，并把「文章 → 会话」的绑定交出去落盘 */
	private bindNewChatId(chatId: number): void {
		const active = this.state.active;
		this.setState({ active: { ...active, chatId } });
		const readingId = active.article?.readingId;
		if (typeof readingId === "number") {
			try {
				this.options.onArticleChatBound?.(readingId, chatId);
			} catch (err) {
				this.options.logger?.error("[chat] 绑定文章会话失败", err);
			}
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
				: [{ chatId, title }, ...sessions];
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
		backfillUserTurnId(messages, snapshot.turnId || last?.turnId || "");
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

/**
 * 本地发出的用户消息还没有 turn_id（要等服务端回），回合结束时补上。
 * 写回 Markdown 时按 turn_id 数回合，口径要和服务端历史的 `total` 一致。
 */
function backfillUserTurnId(messages: ChatMessage[], turnId: string): void {
	if (!turnId) return;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		if (message.turnId) return;
		messages[i] = { ...message, id: `user-${turnId}`, turnId };
		return;
	}
}

export function buildReadingContext(
	article: ArticleBinding | null,
	selectedText?: string
): ChatContextModel | undefined {
	if (!article) return undefined;
	const params: Record<string, unknown> = { reading_id: article.readingId };
	const selection = selectedText?.trim();
	if (selection) params.selected_text = selection;
	return { type: "reading", params };
}
