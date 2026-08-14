import type { Plugin, Workspace } from "obsidian";
import type { PuzleClient } from "../core/api/client";
import type { PuzleSocket } from "../core/ws/manager";
import type { PluginDeps } from "../deps";
import { ChatController } from "./controller";
import { ChatView, VIEW_TYPE_CHAT } from "./view";

const OPEN_CHAT_COMMAND_ID = "open-puzle-chat";
const OPEN_CHAT_COMMAND_NAME = "打开聊天";
const OPEN_CHAT_LABEL = "Puzle Read: 打开聊天";

export function registerChatFeature(plugin: Plugin, deps: PluginDeps): void {
	let controller: ChatController | null = null;
	let boundSocket: PuzleSocket | null = null;
	let boundClient: PuzleClient | null = null;

	const getController = (): ChatController => {
		const socket = deps.getSocket();
		const client = deps.getClient();
		if (!controller || boundSocket !== socket || boundClient !== client) {
			controller?.dispose();
			boundSocket = socket;
			boundClient = client;
			controller = new ChatController(socket, client, { logger: deps.logger });
		}
		return controller;
	};

	plugin.registerView(
		VIEW_TYPE_CHAT,
		(leaf) => new ChatView(leaf, getController, () => deps.getSettings().keepThinking)
	);

	plugin.addCommand({
		id: OPEN_CHAT_COMMAND_ID,
		name: OPEN_CHAT_COMMAND_NAME,
		callback: () => {
			void activateChatView(plugin.app.workspace);
		}
	});

	plugin.addRibbonIcon("message-square", OPEN_CHAT_LABEL, () => {
		void activateChatView(plugin.app.workspace);
	});

	plugin.register(() => {
		controller?.dispose();
		controller = null;
		boundSocket = null;
		boundClient = null;
	});
}

async function activateChatView(workspace: Workspace): Promise<void> {
	const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
	const leaf = existing.length > 0 ? existing[0] : workspace.getRightLeaf(false);
	if (!leaf) return;
	await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
	await workspace.revealLeaf(leaf);
}
