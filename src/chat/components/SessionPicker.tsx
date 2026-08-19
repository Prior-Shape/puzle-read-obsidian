import type { ChatSessionInfo } from "../controller";

export interface SessionPickerProps {
	sessions: ChatSessionInfo[];
	activeChatId: number | null;
	activeTitle: string | null;
	disabled?: boolean;
	loading?: boolean;
	onOpenSession(chatId: number): void;
	onNewSession(): void;
	/** 打开该会话的 `Chats/*.md` 留档；不传则不渲染该按钮 */
	onOpenNote?(chatId: number): void;
}

export function SessionPicker({
	sessions,
	activeChatId,
	activeTitle,
	disabled,
	loading,
	onOpenSession,
	onNewSession,
	onOpenNote
}: SessionPickerProps) {
	const hasActive = activeChatId !== null && sessions.some((entry) => entry.chatId === activeChatId);
	return (
		<div className="puzle-chat-header">
			<select
				className="puzle-chat-session-select"
				value={activeChatId === null ? "" : String(activeChatId)}
				disabled={disabled}
				onChange={(event) => {
					const value = event.target.value;
					if (value === "") {
						onNewSession();
						return;
					}
					const chatId = Number.parseInt(value, 10);
					if (Number.isFinite(chatId)) onOpenSession(chatId);
				}}
			>
				<option value="">新对话</option>
				{!hasActive && activeChatId !== null && (
					<option value={String(activeChatId)}>{activeTitle?.trim() || `对话 ${activeChatId}`}</option>
				)}
				{sessions.map((entry) => (
					<option key={entry.chatId} value={String(entry.chatId)}>
						{entry.title}
					</option>
				))}
				{loading && (
					<option value="" disabled>
						正在加载会话…
					</option>
				)}
			</select>
			<button
				type="button"
				className="puzle-chat-new-button clickable"
				title="新建对话"
				aria-label="新建对话"
				disabled={disabled}
				onClick={onNewSession}
			>
				+
			</button>
			{onOpenNote && activeChatId !== null && (
				<button
					type="button"
					className="puzle-chat-note-button clickable"
					title="打开对话笔记"
					aria-label="打开对话笔记"
					onClick={() => onOpenNote(activeChatId)}
				>
					📄
				</button>
			)}
		</div>
	);
}
