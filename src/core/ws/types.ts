export type UserFrontEventCategory = "system" | "chat" | "task" | "suggestion" | "agent";

export type StreamMarker = "started" | "delta" | "completed" | "full" | "hidden";

export interface WsEvent {
	type: string;
	[key: string]: unknown;
}

export interface UserFrontEvent {
	event_id?: string;
	category: UserFrontEventCategory;
	timestamp?: string;
	user_id?: number;
	event: WsEvent;
}

export interface TextLog {
	type: "text";
	text?: string;
	delta?: string;
	marker?: StreamMarker;
	role?: string;
}

export interface WsChatMessageContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export type ChatEventDetail = TextLog | WsChatMessageContent[];

export interface AgentLogContent {
	type: string;
	marker?: StreamMarker;
	delta?: string;
	[key: string]: unknown;
}

export interface ChatTaskOutput {
	resource_type: string;
	resource_id: number;
}

export interface ChatStreamEvent extends WsEvent {
	message?: string;
	chat_id?: number;
	puzle_id?: number;
	turn_id?: string;
	role?: string;
	detail?: ChatEventDetail;
	log?: AgentLogContent;
	task_id?: number;
	outputs?: ChatTaskOutput[];
	title?: string;
	status?: string;
	error?: string | null;
	meta?: Record<string, unknown> | null;
}

export interface WsChatHistoryTurnEvent {
	type: string;
	role?: string;
	detail?: ChatEventDetail;
	log?: AgentLogContent;
	outputs?: ChatTaskOutput[];
	title?: string;
	[key: string]: unknown;
}

export interface WsChatTurn {
	turn_id: string;
	events: WsChatHistoryTurnEvent[];
}

export interface WsChatHistoryResponse {
	type: string;
	chat_id: number;
	puzle_id?: number;
	title?: string | null;
	total?: number;
	has_more: boolean;
	turns: WsChatTurn[];
	request?: { type?: string; chat_id?: number; offset?: number; limit?: number };
	[key: string]: unknown;
}

export interface WsChatCompletionAck {
	type: "chat_completion_ack";
	chat_id: number;
	puzle_id?: number;
	request?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface WsStopCompletionAck {
	type: "stop_completion_ack";
	chat_id: number;
	stopped?: boolean;
	request?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface WsErrorResponse {
	type: "error";
	message: string;
	request?: Record<string, unknown>;
}

export interface ChatContextModel {
	type: string;
	params?: Record<string, unknown>;
}

export interface ChatContentFileInput {
	type: "image" | "file" | "audio";
	file_key: string;
	filename?: string;
}

export type ChatContentInput = string | Array<{ type: "text"; text: string } | ChatContentFileInput>;

export interface SendChatCompletionParams {
	chat_id?: number | null;
	content: ChatContentInput;
	context?: ChatContextModel | null;
	client_request_id?: string;
}
