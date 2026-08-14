import { isTextLog } from "./stream";
import type {
	AgentLogContent,
	ChatEventDetail,
	ChatTaskOutput,
	WsChatHistoryResponse,
	WsChatHistoryTurnEvent,
	WsChatTurn
} from "./types";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	turnId: string;
	logs?: AgentLogContent[];
	taskOutputs?: ChatTaskOutput[];
}

export function mapChatHistoryResponse(response: WsChatHistoryResponse): ChatMessage[] {
	return mapChatHistoryTurns(response.turns ?? []);
}

export function mapChatHistoryTurns(turns: WsChatTurn[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const turn of turns) {
		let userContent = "";
		let assistantContent = "";
		const logs: AgentLogContent[] = [];
		const taskOutputs: ChatTaskOutput[] = [];

		for (const event of turn.events ?? []) {
			if (event.type === "message") {
				const role = resolveRole(event);
				if (role === "user") {
					const content = extractContent(event.detail);
					if (content) userContent = userContent ? `${userContent}\n${content}` : content;
					continue;
				}
				if (isTextLog(event.detail) && event.detail.marker === "hidden") {
					assistantContent = "";
					continue;
				}
				const content = extractContent(event.detail);
				if (content) {
					assistantContent = assistantContent ? `${assistantContent}\n\n${content}` : content;
				}
			} else if (event.type === "log" && event.log) {
				logs.push(event.log);
			} else if (event.type === "task_output" && Array.isArray(event.outputs)) {
				taskOutputs.push(...(event.outputs as ChatTaskOutput[]));
			}
		}

		if (userContent) {
			messages.push({
				id: `user-${turn.turn_id}`,
				role: "user",
				content: userContent,
				turnId: turn.turn_id
			});
		}
		if (assistantContent || logs.length > 0 || taskOutputs.length > 0) {
			messages.push({
				id: `assistant-${turn.turn_id}`,
				role: "assistant",
				content: assistantContent,
				turnId: turn.turn_id,
				logs: logs.length > 0 ? logs : undefined,
				taskOutputs: taskOutputs.length > 0 ? taskOutputs : undefined
			});
		}
	}
	return messages;
}

function resolveRole(event: WsChatHistoryTurnEvent): string {
	if (event.role) return event.role;
	if (isTextLog(event.detail) && event.detail.role) return event.detail.role;
	return "assistant";
}

function extractContent(detail: ChatEventDetail | undefined): string {
	if (detail === undefined || detail === null) return "";
	if (Array.isArray(detail)) {
		return detail.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n");
	}
	return typeof detail.text === "string" ? detail.text : "";
}
