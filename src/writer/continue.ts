import type { Logger } from "../core/ports";
import type { PuzleSocket, Unsubscribe } from "../core/ws/manager";
import { TurnStreamReducer, isTextLog } from "../core/ws/stream";
import type { ChatStreamEvent, TextLog, WsEvent } from "../core/ws/types";

export const CONTINUE_COMMAND_ID = "puzle-continue-writing";
export const CONTINUE_COMMAND_NAME = "AI 续写";
export const CONTINUE_MENU_LABEL = "AI 续写";
export const CONTINUE_STATUS_LABEL = "Puzle 续写中…（点击停止）";
export const DEFAULT_CONTINUE_MAX_CHARS = 4000;

export function buildContinuePrompt(prefix: string): string {
	return `请直接续写以下文字，不要重复原文，不要解释，直接输出续写内容：\n\n${prefix}`;
}

export function extractContinuePrefix(textBeforeCursor: string, maxChars: number): string {
	const limit =
		Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_CONTINUE_MAX_CHARS;
	return textBeforeCursor.slice(-limit);
}

export const GUARD_CHARS = 32;

export interface ContinueWriterEditor {
	replaceRange(text: string, from: number, to: number): void;
	getRange(from: number, to: number): string;
}

export interface ContinuationChatStore {
	readonly continuationChatId: number | null;
	setContinuationChatId(value: number | null): void;
	flush(): Promise<void>;
}

export interface ContinueWriterOptions {
	logger?: Logger;
	notice?: (message: string) => void;
	onRunningChange?: (running: boolean) => void;
}

export class ContinueWriter {
	private readonly socket: PuzleSocket;
	private readonly store: ContinuationChatStore;
	private readonly options: ContinueWriterOptions;
	private readonly reducer = new TurnStreamReducer();
	private unsubscribers: Unsubscribe[] = [];
	private running = false;
	private stopping = false;
	private chatId: number | null = null;
	private requestId = "";
	private editor: ContinueWriterEditor | null = null;
	private insertStart = 0;
	private insertEnd = 0;
	private insertedText = "";
	private guardText = "";
	private guardFrom = 0;
	private disposed = false;

	constructor(socket: PuzleSocket, store: ContinuationChatStore, options: ContinueWriterOptions = {}) {
		this.socket = socket;
		this.store = store;
		this.options = options;
	}

	get isRunning(): boolean {
		return this.running;
	}

	start(editor: ContinueWriterEditor, insertAt: number, prefix: string): boolean {
		if (this.disposed) return false;
		if (this.running) {
			this.options.notice?.("已有续写任务正在执行");
			return false;
		}
		if (!prefix.trim()) {
			this.options.notice?.("光标前没有可续写的内容");
			return false;
		}
		this.editor = editor;
		this.insertStart = Math.max(0, insertAt);
		this.insertEnd = this.insertStart;
		this.insertedText = "";
		this.guardFrom = Math.max(0, this.insertStart - GUARD_CHARS);
		try {
			this.guardText = editor.getRange(this.guardFrom, this.insertStart);
		} catch {
			this.guardText = "";
			this.guardFrom = this.insertStart;
		}
		this.chatId = this.store.continuationChatId;
		this.stopping = false;
		this.requestId = `puzle-continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.reducer.reset();
		this.running = true;
		this.subscribe();
		this.options.onRunningChange?.(true);
		this.socket.sendChatCompletion({
			chat_id: this.chatId,
			content: buildContinuePrompt(prefix),
			client_request_id: this.requestId
		});
		return true;
	}

	stop(): void {
		if (this.disposed || !this.running || this.stopping) return;
		this.stopping = true;
		if (this.chatId !== null) this.socket.stopCompletion(this.chatId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		const wasRunning = this.running;
		this.running = false;
		this.editor = null;
		if (wasRunning) this.options.onRunningChange?.(false);
	}

	private subscribe(): void {
		this.unsubscribe();
		this.unsubscribers = [
			this.socket.onType("chat_completion_ack", (event) => this.handleAck(event)),
			this.socket.on("chat", (event) => this.handleChatEvent(event as ChatStreamEvent)),
			this.socket.onType("error", (event) => this.handleError(event)),
			this.socket.onConnectionLost(() => this.handleConnectionLost())
		];
	}

	private handleConnectionLost(): void {
		if (!this.running) return;
		this.resetTurn();
		this.options.notice?.("连接已断开，续写中止");
	}

	private unsubscribe(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
	}

	private handleAck(event: WsEvent): void {
		if (!this.running || this.chatId !== null) return;
		const chatId = typeof event.chat_id === "number" ? event.chat_id : null;
		if (chatId === null) return;
		const request = event.request as { client_request_id?: unknown } | undefined;
		const ackRequestId =
			request && typeof request.client_request_id === "string" ? request.client_request_id : null;
		if (ackRequestId !== null && ackRequestId !== this.requestId) return;
		this.chatId = chatId;
		if (this.store.continuationChatId !== chatId) {
			this.store.setContinuationChatId(chatId);
			void this.store.flush();
		}
		if (this.stopping) this.socket.stopCompletion(chatId);
	}

	private handleChatEvent(event: ChatStreamEvent): void {
		if (!this.running) return;
		const eventChatId = typeof event.chat_id === "number" ? event.chat_id : undefined;
		if (eventChatId !== undefined) {
			if (this.chatId === null) {
				if (event.type !== "turn_start") return;
				this.chatId = eventChatId;
			} else if (eventChatId !== this.chatId) {
				return;
			}
		}
		if (event.type === "turn_end") {
			this.reducer.handle(event);
			this.finish(event);
			return;
		}
		this.reducer.handle(event);
		if (this.stopping || event.type !== "message") return;
		const detail = event.detail;
		if (!isTextLog(detail)) return;
		const role = event.role ?? detail.role ?? "assistant";
		if (role !== "assistant") return;
		this.applyText(detail);
	}

	private applyText(detail: TextLog): void {
		const editor = this.editor;
		if (!editor) return;
		if (!this.editorIntact(editor)) {
			this.abortForEditorChange();
			return;
		}
		try {
			this.applyTextEdit(editor, detail);
		} catch {
			this.abortForEditorChange();
		}
	}

	private applyTextEdit(editor: ContinueWriterEditor, detail: TextLog): void {
		const marker = detail.marker;
		if (marker === "started" || marker === "delta") {
			const delta = detail.delta ?? "";
			if (!delta) return;
			editor.replaceRange(delta, this.insertEnd, this.insertEnd);
			this.insertEnd += delta.length;
			this.insertedText += delta;
			return;
		}
		if (marker === "hidden") {
			if (this.insertEnd > this.insertStart) {
				editor.replaceRange("", this.insertStart, this.insertEnd);
				this.insertEnd = this.insertStart;
				this.insertedText = "";
			}
			return;
		}
		const full = detail.text ?? "";
		if (marker === "completed" || marker === "full" || full) {
			editor.replaceRange(full, this.insertStart, this.insertEnd);
			this.insertEnd = this.insertStart + full.length;
			this.insertedText = full;
		}
	}

	/**
	 * The insertion range and a short stretch of text before it must still read
	 * back exactly what we wrote; any divergence means the user edited the
	 * document mid-stream and our offsets can no longer be trusted.
	 */
	private editorIntact(editor: ContinueWriterEditor): boolean {
		try {
			return (
				editor.getRange(this.guardFrom, this.insertStart) === this.guardText &&
				editor.getRange(this.insertStart, this.insertEnd) === this.insertedText
			);
		} catch {
			return false;
		}
	}

	private abortForEditorChange(): void {
		const chatId = this.chatId;
		this.resetTurn();
		if (chatId !== null) this.socket.stopCompletion(chatId);
		this.options.notice?.("检测到文档被编辑，续写已中止");
	}

	private handleError(event: WsEvent): void {
		if (!this.running) return;
		const request = event.request as { type?: unknown; client_request_id?: unknown } | undefined;
		if (request) {
			if (
				typeof request.type === "string" &&
				request.type !== "chat_completion" &&
				request.type !== "stop_completion"
			) {
				return;
			}
			if (typeof request.client_request_id === "string" && request.client_request_id !== this.requestId) {
				return;
			}
		}
		const message = typeof event.message === "string" && event.message ? event.message : "续写请求失败";
		this.resetTurn();
		this.options.notice?.(message);
	}

	private finish(event: ChatStreamEvent): void {
		const status = event.status;
		const error = event.error;
		this.resetTurn();
		if (status === "error") {
			this.options.notice?.(typeof error === "string" && error ? error : "续写失败");
		} else if (status === "cancelled") {
			this.options.logger?.debug("[writer] continuation stopped");
		}
	}

	private resetTurn(): void {
		this.running = false;
		this.stopping = false;
		this.chatId = null;
		this.requestId = "";
		this.editor = null;
		this.reducer.reset();
		this.unsubscribe();
		this.options.onRunningChange?.(false);
	}
}
