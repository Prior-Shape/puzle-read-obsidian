import type { PuzleSocket } from "../../src/core/ws/manager";
import type {
	AgentLogContent,
	WsChatHistoryResponse,
	WsChatHistoryTurnEvent,
	WsChatTurn
} from "../../src/core/ws/types";

export function makeUserEvent(text: string): WsChatHistoryTurnEvent {
	return { type: "message", role: "user", detail: [{ type: "text", text }] };
}

export function makeAssistantEvent(text: string): WsChatHistoryTurnEvent {
	return {
		type: "message",
		role: "assistant",
		detail: { type: "text", text, marker: "full" }
	};
}

export function makeLogEvent(log: AgentLogContent): WsChatHistoryTurnEvent {
	return { type: "log", log };
}

export function makeChatTurn(turnId: string, events: WsChatHistoryTurnEvent[]): WsChatTurn {
	return { turn_id: turnId, events };
}

export function makeHistoryResponse(
	overrides: Partial<WsChatHistoryResponse> = {}
): WsChatHistoryResponse {
	return {
		type: "chat_history_response",
		chat_id: 214,
		puzle_id: 1727,
		title: "关于阅读层次的讨论",
		total: 0,
		has_more: false,
		turns: [],
		...overrides
	};
}

export class FakeChatSocket {
	historyCalls: Array<{ chatId: number; offset: number; limit: number }> = [];
	fullHistoryCalls: number[] = [];
	firstPages = new Map<number, WsChatHistoryResponse>();
	fullHistories = new Map<number, WsChatHistoryResponse>();
	failFullFor = new Set<number>();
	cancelFullFor = new Set<number>();

	async requestChatHistory(
		chatId: number,
		offset = 0,
		limit = 20
	): Promise<WsChatHistoryResponse> {
		this.historyCalls.push({ chatId, offset, limit });
		const page = this.firstPages.get(chatId);
		if (!page) throw new Error(`no first-page fixture for chat ${chatId}`);
		return page;
	}

	async requestFullChatHistory(
		chatId: number,
		isCancelled?: () => boolean
	): Promise<WsChatHistoryResponse | null> {
		this.fullHistoryCalls.push(chatId);
		if (this.cancelFullFor.has(chatId) || isCancelled?.()) return null;
		if (this.failFullFor.has(chatId)) throw new Error("chat_history failed");
		const full = this.fullHistories.get(chatId);
		if (!full) throw new Error(`no full-history fixture for chat ${chatId}`);
		return full;
	}

	asSocket(): PuzleSocket {
		return this as unknown as PuzleSocket;
	}
}
