import type { PuzleClient } from "../core/api/client";
import type { Logger } from "../core/ports";
import type { Settings } from "../settings";
import type { VaultGateway } from "../vault/gateway";
import { articleFingerprint, fetchArticlePayload, writeArticleNote } from "./article-syncer";
import {
	createSharedState,
	errorMessage,
	syncTimestamp,
	type SyncContext
} from "./engine";
import { HighlightSyncer } from "./highlight-syncer";
import type { SyncStore } from "./store";

export interface ArticleRefresherOptions {
	getClient(): PuzleClient;
	getGateway(): VaultGateway;
	getSettings(): Settings;
	store: SyncStore;
	notice(message: string): void;
	logger?: Logger;
}

/**
 * 划词创建高亮 / 发表想法之后，立刻把这一篇重新渲染一遍。
 * 走的是 ArticleSyncer 的同一条写入路径（正文锚点 + 高亮笔记 + 记账），
 * 只是把范围收窄到一篇 —— 不然 `==高亮==` 要等下一次同步才出现。
 */
export class ArticleRefresher {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: ArticleRefresherOptions) {}

	/** 串行排队：连着创建几条高亮时不会互相插队写同一个文件 */
	refresh(readingId: number): Promise<boolean> {
		const next = this.queue.then(() => this.refreshNow(readingId));
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async refreshNow(readingId: number): Promise<boolean> {
		const { store, logger } = this.options;
		try {
			const detail = await this.fetchDetail(readingId);
			const ctx: SyncContext = {
				mode: "full",
				client: this.options.getClient(),
				vaultGateway: this.options.getGateway(),
				store,
				settings: this.options.getSettings(),
				shared: createSharedState(),
				now: syncTimestamp(),
				notice: this.options.notice
			};
			const payload = await fetchArticlePayload(ctx, detail, detail);
			await writeArticleNote(ctx, {
				item: detail,
				fingerprint: articleFingerprint(detail),
				...payload
			});
			// 只处理这一篇产生的高亮批次；别的文章没进 remoteHighlightIds，删除清理不会误伤
			await new HighlightSyncer().sync(ctx);
			await store.flush();
			return true;
		} catch (error) {
			logger?.error("[sync] 刷新文章笔记失败", error);
			this.options.notice(
				`Puzle Read：笔记刷新失败，下次同步会补上 — ${errorMessage(error)}`
			);
			return false;
		}
	}

	/** 老数据没记 resourceType，link 打不开就试 file */
	private async fetchDetail(readingId: number) {
		const client = this.options.getClient();
		const known = this.options.store.getArticle(readingId)?.resourceType;
		if (known === "file") return client.getFileDetail(readingId);
		if (known === "link") return client.getLinkDetail(readingId);
		try {
			return await client.getLinkDetail(readingId);
		} catch {
			return await client.getFileDetail(readingId);
		}
	}
}
