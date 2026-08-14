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
}

export function ChatPanel({ app, getController, getKeepThinking }: ChatPanelProps) {
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

	return (
		<div className="puzle-chat">
			<SessionPicker
				sessions={state.sessions}
				activeChatId={active.chatId}
				activeTitle={active.title}
				disabled={active.streaming}
				onOpenSession={(chatId) => void controller.openSession(chatId)}
				onNewSession={() => controller.newSession()}
			/>
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
