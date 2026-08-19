import { Notice, TFile } from "obsidian";
import type { App, Menu, Plugin } from "obsidian";
import type { PuzleSocket } from "../core/ws/manager";
import type { PluginDeps } from "../deps";
import type { ChatNotes } from "../sync/chat-notes";
import type { PuzleContextMenu } from "../ui/context-menu";
import { activateLeaf } from "../ui/leaf";
import { ChatController } from "./controller";
import type { ArticleBinding, ChatStateListener } from "./controller";
import { ChatView, VIEW_TYPE_CHAT } from "./view";

export interface ArticleChatTarget {
	binding: ArticleBinding;
	chatId: number | null;
}

export interface ChatFeature {
	/** 供批注面板「就这段提问」调用：按文章笔记路径打开它的会话并带上引用原文 */
	openArticleChatByPath(path: string, selectedText?: string): Promise<void>;
}

export function registerChatFeature(
	plugin: Plugin,
	deps: PluginDeps,
	hooks: { chatNotes: ChatNotes; contextMenu: PuzleContextMenu }
): ChatFeature {
	const chatNotes = hooks.chatNotes;
	let controller: ChatController | null = null;
	let boundSocket: PuzleSocket | null = null;

	const getController = (): ChatController => {
		const socket = deps.getSocket();
		if (!controller || boundSocket !== socket) {
			controller?.dispose();
			boundSocket = socket;
			controller = new ChatController(socket, deps.getClient, {
				logger: deps.logger,
				getExcludedChatId: () => deps.getData().syncState.continuationChatId,
				onArticleChatBound: (readingId, chatId) => {
					void persistArticleChatId(plugin.app, deps, readingId, chatId);
				}
			});
			controller.subscribe(watchChatNotes(chatNotes));
		}
		return controller;
	};

	const openNote = (chatId: number): void => {
		const path = chatNotes.pathOf(chatId);
		if (!path) {
			new Notice("Puzle Read：该对话还没有笔记，说完一轮或同步一次后就会生成");
			return;
		}
		void plugin.app.workspace.openLinkText(path, "", false);
	};

	plugin.registerView(
		VIEW_TYPE_CHAT,
		(leaf) =>
			new ChatView(leaf, {
				getController,
				getKeepThinking: () => deps.getSettings().keepThinking,
				openNote,
				openArticle: (path) => {
					void plugin.app.workspace.openLinkText(path, "", false);
				}
			})
	);

	plugin.addCommand({
		id: "open-puzle-chat",
		name: "打开聊天",
		callback: () => {
			void activateLeaf(plugin.app, VIEW_TYPE_CHAT, "right");
		}
	});
	plugin.addCommand({
		id: "puzle-chat-with-article",
		name: "与本文对话",
		checkCallback: (checking: boolean) => {
			const target = resolveArticleTarget(plugin.app, deps, activeFile(plugin.app));
			if (!target) return false;
			if (checking) return true;
			void openArticleChat(plugin.app, getController(), target);
			return true;
		}
	});

	plugin.addRibbonIcon("message-square", "Puzle Read: 打开聊天", () => {
		void activateLeaf(plugin.app, VIEW_TYPE_CHAT, "right");
	});

	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu: Menu, file) => {
			if (!(file instanceof TFile)) return;
			const target = resolveArticleTarget(plugin.app, deps, file);
			if (!target) return;
			addArticleChatMenuItem(menu, () =>
				void openArticleChat(plugin.app, getController(), target)
			);
		})
	);
	// 正文右键：阅读模式与编辑模式都有，选中了文字就是「就这段提问」
	hooks.contextMenu.register(({ file, selection }) => {
		const target = resolveArticleTarget(plugin.app, deps, file);
		if (!target) return [];
		const snippet = selection?.selected.trim() || "";
		return [
			{
				title: snippet ? "Puzle: 就这段提问" : ARTICLE_CHAT_TITLE,
				icon: "message-square",
				onClick: () => {
					void openArticleChat(plugin.app, getController(), target, snippet || undefined);
				}
			}
		];
	});

	plugin.register(() => {
		controller?.dispose();
		controller = null;
		boundSocket = null;
		chatNotes.setBusy(null);
	});

	return {
		openArticleChatByPath: async (path, selectedText) => {
			const file = plugin.app.vault.getFileByPath(path);
			const target = resolveArticleTarget(plugin.app, deps, file);
			if (!target) return;
			await openArticleChat(plugin.app, getController(), target, selectedText);
		}
	};
}

/**
 * 聊天 → Markdown 的写回时机。
 * 流式过程中只把会话标成 busy（同步据此绕开它，免得用服务端旧历史盖掉本地新内容），
 * 一轮说完（streaming 由 true 落回 false）才整段重渲染写进 `Chats/*.md` —— 不逐 token 写盘。
 */
export function watchChatNotes(chatNotes: ChatNotes): ChatStateListener {
	let streaming = false;
	return (state) => {
		const active = state.active;
		chatNotes.setBusy(active.streaming ? active.chatId : null);
		const finished = streaming && !active.streaming;
		streaming = active.streaming;
		if (!finished || active.chatId === null || active.messages.length === 0) return;
		void chatNotes.write({
			chatId: active.chatId,
			title: active.title,
			messages: active.messages
		});
	};
}

const ARTICLE_CHAT_TITLE = "Puzle: 与本文对话";

function addArticleChatMenuItem(menu: Menu, onClick: () => void, title = ARTICLE_CHAT_TITLE): void {
	menu.addItem((item) => {
		item.setTitle(title).setIcon("message-square").onClick(onClick);
	});
}

function activeFile(app: App): TFile | null {
	// 焦点在聊天/批注侧边栏时 getActiveViewOfType 会是 null，getActiveFile 仍指向那篇笔记
	return app.workspace.getActiveFile();
}

/**
 * 一篇文章只对应一个会话：已有 chat_id 就继续，没有才开新的。
 * chat_id 优先取本地同步状态（刚绑定过的最新），其次取笔记 frontmatter。
 */
export function resolveArticleTarget(
	app: App,
	deps: PluginDeps,
	file: TFile | null
): ArticleChatTarget | null {
	if (!file || file.extension !== "md") return null;
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!frontmatter) return null;
	const readingId = numeric(frontmatter.reading_id);
	if (readingId === null) return null;
	const stored = deps.getData().syncState.articles[readingId];
	const chatId = numeric(stored?.chatId) ?? numeric(frontmatter.chat_id);
	const title =
		(typeof frontmatter.title === "string" && frontmatter.title.trim()) || file.basename;
	return {
		binding: { readingId, title, path: file.path },
		chatId
	};
}

async function openArticleChat(
	app: App,
	controller: ChatController,
	target: ArticleChatTarget,
	selectedText?: string
): Promise<void> {
	await activateLeaf(app, VIEW_TYPE_CHAT, "right");
	await controller.openArticleChat(target.binding, target.chatId, selectedText);
}

/** 把新建会话的 chat_id 绑回文章：同步状态 + 笔记 frontmatter 双写，下次打开即可续聊 */
async function persistArticleChatId(
	app: App,
	deps: PluginDeps,
	readingId: number,
	chatId: number
): Promise<void> {
	const data = deps.getData();
	const stored = data.syncState.articles[readingId];
	if (stored) {
		stored.chatId = chatId;
		await deps.saveData();
	}
	const path = stored?.path;
	if (!path) return;
	const file = app.vault.getFileByPath(path);
	if (!file) return;
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.chat_id = chatId;
	});
}

function numeric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
