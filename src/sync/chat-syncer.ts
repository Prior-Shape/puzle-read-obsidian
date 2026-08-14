import { isChatReadingItem } from "../core/models";
import type { ReadingItem } from "../core/models";
import { mapChatHistoryResponse } from "../core/ws/history";
import { HISTORY_PAGE_LIMIT } from "../core/ws/manager";
import type { PuzleSocket } from "../core/ws/manager";
import type { WsChatHistoryResponse } from "../core/ws/types";
import { sanitizeFileName } from "../vault/gateway";
import { hashManaged } from "../vault/managed";
import {
	createReport,
	errorMessage,
	storedRelativePath,
	type SyncContext,
	type SyncReport,
	type Syncer
} from "./engine";
import { chatFrontmatter, renderChatManaged } from "./render/chat";

export type ChatItem = ReadingItem & { resource_type: "chat"; chat_id: number };

type ItemOutcome = "created" | "updated" | "skipped";

export function chatBaseName(title: string, chatId: number): string {
	return `${sanitizeFileName(title)} (c${chatId})`;
}

export function resolveTurnTotal(response: WsChatHistoryResponse): number | null {
	if (typeof response.total === "number") return response.total;
	if (!response.has_more) return (response.turns ?? []).length;
	return null;
}

export class ChatSyncer implements Syncer {
	readonly key = "chats";

	constructor(private readonly getSocket: () => PuzleSocket) {}

	async sync(ctx: SyncContext): Promise<SyncReport> {
		const report = createReport(this.key);
		const { client, store } = ctx;

		for await (const item of client.iterateAllReadingItems()) {
			if (ctx.signal?.aborted) break;
			if (!isChatReadingItem(item)) continue;
			if (item.status === "thinking") {
				report.skipped += 1;
				continue;
			}
			if (item.chat_id === store.continuationChatId) {
				report.skipped += 1;
				continue;
			}

			try {
				const outcome = await this.syncChat(ctx, item);
				report[outcome] += 1;
			} catch (error) {
				report.failed += 1;
				ctx.notice(
					`Puzle Read：对话「${item.title ?? item.chat_id}」同步失败：${errorMessage(error)}`
				);
			}
		}

		await store.flush();
		return report;
	}

	private async syncChat(ctx: SyncContext, item: ChatItem): Promise<ItemOutcome> {
		const { store, settings, vaultGateway } = ctx;
		const chatId = item.chat_id;
		const socket = this.getSocket();

		const probe = await socket.requestChatHistory(chatId, 0, HISTORY_PAGE_LIMIT);
		const total = resolveTurnTotal(probe);
		const prev = store.getChat(chatId);
		if (prev && total !== null && prev.turnCount === total) return "skipped";

		const response = await socket.requestFullChatHistory(
			chatId,
			() => ctx.signal?.aborted === true
		);
		if (!response) return "skipped";

		const turnCount = resolveTurnTotal(response) ?? (response.turns ?? []).length;
		const title = response.title?.trim() || item.title?.trim() || `对话 ${chatId}`;
		const relative = storedRelativePath(
			vaultGateway,
			prev?.path,
			`Chats/${chatBaseName(title, chatId)}.md`
		);

		if (prev && settings.onEditedManaged === "skip") {
			const current = await vaultGateway.readManagedHash(relative);
			if (current !== null && prev.managedHash && current !== prev.managedHash) {
				ctx.notice(`Puzle Read：对话「${title}」managed 区有本地修改，已跳过`);
				return "skipped";
			}
		}

		const managed = renderChatManaged({
			messages: mapChatHistoryResponse(response),
			keepThinking: settings.keepThinking
		});
		const file = await vaultGateway.writeManaged(
			relative,
			chatFrontmatter(item, title, ctx.now),
			managed
		);
		const managedHash =
			(await vaultGateway.readManagedHash(relative)) ?? hashManaged(managed);

		store.setChat(chatId, { path: file.path, turnCount, managedHash });
		return prev ? "updated" : "created";
	}
}
