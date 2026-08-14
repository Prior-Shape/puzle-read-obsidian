import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ChatPanel } from "./components/ChatPanel";
import type { ChatController } from "./controller";

export const VIEW_TYPE_CHAT = "puzle-chat-view";

export class ChatView extends ItemView {
	private readonly getController: () => ChatController;
	private readonly getKeepThinking: () => boolean;
	private root: Root | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		getController: () => ChatController,
		getKeepThinking: () => boolean
	) {
		super(leaf);
		this.getController = getController;
		this.getKeepThinking = getKeepThinking;
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
			<ChatPanel app={this.app} getController={this.getController} getKeepThinking={this.getKeepThinking} />
		);
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
		this.root = null;
	}
}
