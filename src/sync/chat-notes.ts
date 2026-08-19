import type { ChatMessage } from "../core/ws/history";
import type { Logger } from "../core/ports";
import type { Settings } from "../settings";
import type { VaultGateway } from "../vault/gateway";
import { hashManaged } from "../vault/managed";
import { chatBaseName } from "./chat-syncer";
import { errorMessage, storedRelativePath, syncTimestamp } from "./engine";
import { liveChatFrontmatter, renderChatManaged } from "./render/chat";
import type { SyncStore } from "./store";

export interface ChatNotesOptions {
	getGateway(): VaultGateway;
	getSettings(): Settings;
	store: SyncStore;
	notice(message: string): void;
	logger?: Logger;
}

export interface ChatNoteInput {
	chatId: number;
	title: string | null;
	messages: ChatMessage[];
}

/**
 * 会话的回合数。同步侧拿服务端 `total` 做增量短路，本地写回必须用同一口径，
 * 且**宁可少算不能多算** —— 少算最多让下次增量同步重写一遍，多算会让它误判「没变」而漏同步。
 * 所以只数已经拿到 turn_id 的回合，外加末尾那条还没等到回复的用户消息。
 */
export function countTurns(messages: ChatMessage[]): number {
	const seen = new Set<string>();
	let pending = 0;
	for (const message of messages) {
		if (message.turnId) {
			seen.add(message.turnId);
			continue;
		}
		if (message.role === "user") pending += 1;
	}
	return seen.size + pending;
}

/**
 * 聊天面板与 `Chats/*.md` 之间的写回通道：每说完一轮就把整段会话重渲染写回同一个文件，
 * 并把 path / turnCount / managedHash 记进同步状态 —— 与 {@link ChatSyncer} 共用一套记账，
 * 下次增量同步看到回合数一致就直接跳过，不会把本地刚写的内容再覆盖一遍。
 */
export class ChatNotes {
	private busyChatId: number | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	/** managed 区被本地改过的会话：只提示一次，别每轮都弹 */
	private readonly warned = new Set<number>();

	constructor(private readonly options: ChatNotesOptions) {}

	/** 正在流式输出的会话；服务端历史此刻还缺最后一轮，同步要绕开它 */
	setBusy(chatId: number | null): void {
		this.busyChatId = chatId;
	}

	isBusy(chatId: number): boolean {
		return this.busyChatId === chatId;
	}

	pathOf(chatId: number): string | null {
		return this.options.store.getChat(chatId)?.path ?? null;
	}

	/** 串行排队，避免连续两轮的写回互相插队后写出旧内容 */
	write(input: ChatNoteInput): Promise<string | null> {
		const next = this.queue.then(() => this.writeNow(input));
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async writeNow(input: ChatNoteInput): Promise<string | null> {
		const { chatId } = input;
		const title = input.title?.trim() || `对话 ${chatId}`;
		const gateway = this.options.getGateway();
		const settings = this.options.getSettings();
		const store = this.options.store;
		const prev = store.getChat(chatId);
		const relative = storedRelativePath(
			gateway,
			prev?.path,
			`Chats/${chatBaseName(title, chatId)}.md`
		);

		try {
			if (prev && settings.onEditedManaged === "skip") {
				const current = await gateway.readManagedHash(relative);
				if (current !== null && prev.managedHash && current !== prev.managedHash) {
					if (!this.warned.has(chatId)) {
						this.warned.add(chatId);
						this.options.notice(
							`Puzle Read：对话「${title}」managed 区有本地修改，已停止自动更新该笔记`
						);
					}
					return prev.path;
				}
			}

			const managed = renderChatManaged({
				messages: input.messages,
				keepThinking: settings.keepThinking
			});
			const file = await gateway.writeManaged(
				relative,
				liveChatFrontmatter(title, syncTimestamp(), chatId),
				managed
			);
			const managedHash = (await gateway.readManagedHash(relative)) ?? hashManaged(managed);
			store.setChat(chatId, {
				path: file.path,
				turnCount: countTurns(input.messages),
				managedHash
			});
			await store.flush();
			this.warned.delete(chatId);
			return file.path;
		} catch (error) {
			this.options.logger?.error("[chat] 写回对话笔记失败", error);
			this.options.notice(`Puzle Read：对话「${title}」写回笔记失败 — ${errorMessage(error)}`);
			return prev?.path ?? null;
		}
	}
}
