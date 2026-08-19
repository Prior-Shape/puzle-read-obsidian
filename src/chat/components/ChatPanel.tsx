import type { App } from "obsidian";
import { useEffect, useState } from "react";
import type { ChatController, ChatControllerState } from "../controller";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionPicker } from "./SessionPicker";

export interface ChatPanelProps {
	app: App;
	getController(): ChatController;
	getKeepThinking(): boolean;
	/** 打开该会话的 `Chats/*.md` 留档；不传则不渲染该按钮 */
	onOpenNote?(chatId: number): void;
	/** 打开绑定的文章笔记 */
	onOpenArticle?(path: string): void;
}

export function ChatPanel({
	app,
	getController,
	getKeepThinking,
	onOpenNote,
	onOpenArticle
}: ChatPanelProps) {
	const [controller, setController] = useState<ChatController | null>(null);
	const [state, setState] = useState<ChatControllerState | null>(null);

	useEffect(() => {
		const instance = getController();
		setController(instance);
		const unsubscribe = instance.subscribe(setState);
		void instance.loadSessions();
		return unsubscribe;
	}, [getController]);

	if (!controller || !state) return null;
	const { active } = state;
	const article = active.article;

	return (
		<div className="puzle-chat puzle-chat-sidebar">
			<SessionPicker
				sessions={state.sessions}
				activeChatId={active.chatId}
				activeTitle={active.title}
				disabled={active.streaming}
				loading={state.sessionsLoading}
				onOpenSession={(chatId) => void controller.openSession(chatId)}
				onNewSession={() => controller.newSession()}
				onOpenNote={onOpenNote}
			/>
			{article && (
				<div className="puzle-chat-article-chip">
					<span>📄 正在讨论：</span>
					{article.path && onOpenArticle ? (
						<a
							href="#"
							onClick={(event) => {
								event.preventDefault();
								onOpenArticle(article.path as string);
							}}
						>
							{article.title}
						</a>
					) : (
						<span>{article.title}</span>
					)}
				</div>
			)}
			{active.pendingSelection && (
				<div className="puzle-chat-quote">
					<span className="puzle-chat-quote-text">“{active.pendingSelection}”</span>
					<button
						type="button"
						className="puzle-chat-quote-clear clickable-icon"
						title="不引用这段"
						aria-label="不引用这段"
						onClick={() => controller.setPendingSelection(null)}
					>
						×
					</button>
				</div>
			)}
			<MessageList
				app={app}
				messages={active.messages}
				streaming={active.streaming}
				loading={active.loading}
				error={active.error}
				keepThinking={getKeepThinking()}
			/>
			<Composer
				streaming={active.streaming}
				disabled={active.loading}
				onSend={(text) => controller.send(text)}
				onStop={() => controller.stop()}
			/>
		</div>
	);
}
