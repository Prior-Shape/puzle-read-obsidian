import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ChatPanel } from "./components/ChatPanel";
import type { ChatController } from "./controller";

export const VIEW_TYPE_CHAT = "puzle-chat-view";

export interface ChatViewDeps {
	getController(): ChatController;
	getKeepThinking(): boolean;
	/** 在主区域打开该会话的 `Chats/*.md`；没有笔记时自行提示 */
	openNote(chatId: number): void;
	openArticle(path: string): void;
}

/** 右边栏聊天面板：对话本身在这里进行，历史留档看 `Chats/*.md` */
export class ChatView extends ItemView {
	private root: Root | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: ChatViewDeps
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return "Puzle Chat";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("puzle-chat-root");
		this.root = createRoot(this.contentEl);
		this.root.render(
			<ChatPanel
				app={this.app}
				getController={this.deps.getController}
				getKeepThinking={this.deps.getKeepThinking}
				onOpenNote={this.deps.openNote}
				onOpenArticle={this.deps.openArticle}
			/>
		);
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
		this.root = null;
	}
}
