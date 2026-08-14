import type { AgentLogContent, ChatStreamEvent, ChatTaskOutput, TextLog } from "./types";

export type TurnStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export interface TurnStreamState {
	text: string;
	thinkingLogs: AgentLogContent[];
	title?: string;
	status: TurnStatus;
	chatId?: number;
	turnId?: string;
	error?: string | null;
	meta?: Record<string, unknown> | null;
	taskOutputs: ChatTaskOutput[];
}

const STREAMABLE_LOG_MAIN_FIELD: Record<string, string> = {
	text: "text",
	thinking: "reasoning",
	observation: "finding"
};

export function isTextLog(detail: unknown): detail is TextLog {
	return (
		!!detail &&
		!Array.isArray(detail) &&
		typeof detail === "object" &&
		(detail as TextLog).type === "text"
	);
}

export function applyMarker(buffer: string, marker: string | undefined, delta: string | undefined, full: string): string {
	switch (marker) {
		case "started":
		case "delta":
			return buffer + (delta ?? "");
		case "completed":
		case "full":
			return full;
		case "hidden":
			return "";
		default:
			return full || buffer;
	}
}

function createInitialState(): TurnStreamState {
	return {
		text: "",
		thinkingLogs: [],
		status: "idle",
		taskOutputs: []
	};
}

export class TurnStreamReducer {
	private state: TurnStreamState = createInitialState();

	get snapshot(): TurnStreamState {
		return {
			...this.state,
			thinkingLogs: [...this.state.thinkingLogs],
			taskOutputs: [...this.state.taskOutputs]
		};
	}

	reset(): TurnStreamState {
		this.state = createInitialState();
		return this.snapshot;
	}

	handle(event: ChatStreamEvent): TurnStreamState {
		switch (event.type) {
			case "turn_start":
				this.state = {
					...createInitialState(),
					status: "streaming",
					chatId: event.chat_id,
					turnId: event.turn_id
				};
				break;
			case "message":
				this.handleMessage(event);
				break;
			case "log":
				this.markStreaming();
				if (event.log) this.appendLog(event.log);
				break;
			case "task_output":
				this.markStreaming();
				if (Array.isArray(event.outputs)) this.state.taskOutputs.push(...event.outputs);
				break;
			case "title_generated":
				this.markStreaming();
				if (typeof event.title === "string") this.state.title = event.title;
				break;
			case "turn_end": {
				const status = event.status;
				this.state.status = status === "error" ? "error" : status === "cancelled" ? "cancelled" : "done";
				this.state.error = typeof event.error === "string" ? event.error : null;
				this.state.meta = event.meta ?? null;
				break;
			}
			default:
				break;
		}
		return this.snapshot;
	}

	private markStreaming(): void {
		if (this.state.status === "idle") this.state.status = "streaming";
	}

	private handleMessage(event: ChatStreamEvent): void {
		const detail = event.detail;
		if (!isTextLog(detail)) return;
		const role = event.role ?? detail.role ?? "assistant";
		if (role === "user") return;
		this.markStreaming();
		this.state.text = applyMarker(this.state.text, detail.marker, detail.delta, detail.text ?? "");
		if (event.chat_id !== undefined) this.state.chatId = event.chat_id;
		if (event.turn_id !== undefined) this.state.turnId = event.turn_id;
	}

	private appendLog(log: AgentLogContent): void {
		const logs = this.state.thinkingLogs;
		const mainField = STREAMABLE_LOG_MAIN_FIELD[log.type];
		const marker = log.marker;

		if (!mainField) {
			logs.push(log);
			return;
		}

		const last = logs[logs.length - 1];
		if (marker === "hidden") {
			if (last && last.type === log.type) logs.pop();
			return;
		}
		if (last && last.type === log.type && (marker === "delta" || marker === "completed")) {
			const updated: AgentLogContent = { ...last };
			if (marker === "delta") {
				updated[mainField] = String(updated[mainField] ?? "") + String(log.delta ?? "");
			} else {
				updated[mainField] = String(log[mainField] ?? updated[mainField] ?? "");
				if (log.type === "thinking" && log.conclusion !== undefined) updated.conclusion = log.conclusion;
			}
			updated.marker = marker;
			logs[logs.length - 1] = updated;
			return;
		}
		const entry: AgentLogContent = { ...log };
		if (marker === "started" || marker === "delta") {
			entry[mainField] = String(log.delta ?? "");
		} else {
			entry[mainField] = String(log[mainField] ?? "");
		}
		logs.push(entry);
	}
}
