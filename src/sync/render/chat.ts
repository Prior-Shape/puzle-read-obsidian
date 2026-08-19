import type { ReadingItem } from "../../core/models";
import type { ChatMessage } from "../../core/ws/history";
import type { AgentLogContent } from "../../core/ws/types";
import { roleLabel } from "./article";

export const THINKING_CALLOUT_TITLE = "> [!note]- 🧠 思考过程";

export function chatFrontmatter(
	item: Pick<ReadingItem, "puzle_id" | "created_time">,
	title: string,
	syncedAt: string,
	chatId: number
): Record<string, unknown> {
	return {
		puzle_type: "chat",
		chat_id: chatId,
		puzle_id: item.puzle_id,
		title,
		created: item.created_time ?? null,
		synced: syncedAt
	};
}

/**
 * 聊天面板实时写回时用的 frontmatter 补丁。
 * 只写插件当下确知的字段：`puzle_id` / `created` 来自 reading item，同步时才补得上，
 * 这里不能带上（processFrontMatter 是逐键覆盖，写 null 会把已同步的值抹掉）。
 */
export function liveChatFrontmatter(
	title: string,
	syncedAt: string,
	chatId: number
): Record<string, unknown> {
	return {
		puzle_type: "chat",
		chat_id: chatId,
		title,
		synced: syncedAt
	};
}

export interface RenderChatManagedInput {
	messages: ChatMessage[];
	keepThinking: boolean;
}

export function renderChatManaged(input: RenderChatManagedInput): string {
	const blocks: string[] = [];
	for (const message of input.messages) {
		const block =
			message.role === "user"
				? renderUserMessage(message)
				: renderAssistantMessage(message, input.keepThinking);
		if (block) blocks.push(block);
	}
	return blocks.join("\n\n");
}

export function renderUserMessage(message: ChatMessage): string | null {
	const content = message.content.trim();
	if (!content) return null;
	const quoted = content
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
	return `## ${roleLabel("user")}\n\n${quoted}`;
}

export function renderAssistantMessage(message: ChatMessage, keepThinking: boolean): string | null {
	const parts: string[] = [];
	const content = message.content.trim();
	if (content.length > 0) parts.push(content);
	if (keepThinking && message.logs && message.logs.length > 0) {
		const callout = renderThinkingCallout(message.logs);
		if (callout) parts.push(callout);
	}
	if (parts.length === 0) return null;
	return [`## ${roleLabel("assistant")}`, ...parts].join("\n\n");
}

export function renderThinkingCallout(logs: AgentLogContent[]): string | null {
	const lines: string[] = [];
	for (const log of logs) {
		const text = describeLog(log);
		if (!text) continue;
		if (lines.length > 0) lines.push("");
		lines.push(...text.split("\n"));
	}
	if (lines.length === 0) return null;
	return [THINKING_CALLOUT_TITLE, ...lines.map((line) => (line.length > 0 ? `> ${line}` : ">"))].join("\n");
}

export function describeLog(log: AgentLogContent): string {
	switch (log.type) {
		case "thinking": {
			const reasoning = typeof log.reasoning === "string" ? log.reasoning : "";
			const conclusion = typeof log.conclusion === "string" ? log.conclusion : "";
			return [reasoning, conclusion].filter(Boolean).join("\n\n");
		}
		case "observation": {
			const environment = typeof log.environment === "string" ? log.environment : "";
			const finding = typeof log.finding === "string" ? log.finding : "";
			return [environment, finding].filter(Boolean).join("\n");
		}
		case "tool_call": {
			const name = typeof log.tool_name === "string" && log.tool_name ? log.tool_name : "tool";
			const args =
				log.tool_args === undefined || log.tool_args === null
					? ""
					: typeof log.tool_args === "string"
						? log.tool_args
						: JSON.stringify(log.tool_args);
			return args ? `${name}(${args})` : name;
		}
		case "tool_result": {
			const name = typeof log.tool_name === "string" && log.tool_name ? log.tool_name : "tool";
			const display =
				typeof log.display === "string" && log.display
					? log.display
					: typeof log.result === "string"
						? log.result
						: "";
			return display ? `${name}: ${display}` : name;
		}
		case "error":
			return typeof log.error_message === "string" ? log.error_message : "";
		case "text":
			return typeof log.text === "string" ? log.text : "";
		default:
			return "";
	}
}
