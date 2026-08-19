import { ITERATE_PAGE_SIZE } from "../core/api/client";
import type {
	CommentItem,
	FileReadingDetail,
	HighlightItem,
	LinkReadingDetail,
	ReadingItem,
	ReadingSummary
} from "../core/models";
import { sanitizeFileName } from "../vault/gateway";
import { hashManaged } from "../vault/managed";
import { injectAnchors, type AnchorHighlight } from "./anchor";
import {
	createReport,
	errorMessage,
	storedRelativePath,
	type SyncContext,
	type SyncReport,
	type Syncer
} from "./engine";
import { articleFrontmatter, renderArticleManaged, sortComments } from "./render/article";
import { normalizeArticleContent } from "./render/html";

export const EARLY_STOP_PAGES = 2;

const SYNCABLE_RESOURCE_TYPES = new Set(["link", "file"]);
const SYNCABLE_STATUSES = new Set(["done", "viewed", "interacted"]);

export function isSyncableArticle(item: ReadingItem): boolean {
	return (
		SYNCABLE_RESOURCE_TYPES.has(item.resource_type) &&
		typeof item.status === "string" &&
		SYNCABLE_STATUSES.has(item.status)
	);
}

export function articleFingerprint(
	item: Pick<
		ReadingItem,
		"status" | "title" | "highlight_count" | "comment_count" | "last_comment_at"
	>
): string {
	return hashManaged(
		[
			item.status ?? "",
			item.title ?? "",
			item.highlight_count ?? 0,
			item.comment_count ?? 0,
			item.last_comment_at ?? ""
		].join("\u0000")
	);
}

export function articleBaseName(item: ReadingItem): string {
	return `${sanitizeFileName(item.title ?? "")} (r${item.id})`;
}

type ItemOutcome = "created" | "updated" | "skipped";

export class ArticleSyncer implements Syncer {
	readonly key = "articles";

	async sync(ctx: SyncContext): Promise<SyncReport> {
		const report = createReport(this.key);
		const { client, store } = ctx;

		let index = 0;
		let lastPage = 0;
		let pageSyncable = 0;
		let pageAllHit = true;
		let consecutiveHitPages = 0;

		for await (const item of client.iterateAllReadingItems()) {
			if (ctx.signal?.aborted) break;

			const page = Math.floor(index / ITERATE_PAGE_SIZE);
			if (page > lastPage) {
				if (pageSyncable > 0) {
					consecutiveHitPages = pageAllHit ? consecutiveHitPages + 1 : 0;
				}
				if (ctx.mode === "incremental" && consecutiveHitPages >= EARLY_STOP_PAGES) break;
				lastPage = page;
				pageSyncable = 0;
				pageAllHit = true;
				await store.flush();
			}
			index += 1;

			if (!isSyncableArticle(item)) continue;
			pageSyncable += 1;

			const fingerprint = articleFingerprint(item);
			const prev = store.getArticle(item.id);
			// 指纹短路只用于增量：全量同步无条件重建，兜底指纹覆盖不到的
			// 变化（如高亮属性编辑不改变计数）
			if (ctx.mode === "incremental" && prev && prev.fingerprint === fingerprint) {
				report.skipped += 1;
				continue;
			}
			pageAllHit = false;

			try {
				const outcome = await this.syncItem(ctx, item, fingerprint);
				report[outcome] += 1;
			} catch (error) {
				report.failed += 1;
				ctx.notice(
					`Puzle Read：文章「${item.title ?? item.id}」同步失败：${errorMessage(error)}`
				);
			}
		}

		await store.flush();
		return report;
	}

	private async syncItem(
		ctx: SyncContext,
		item: ReadingItem,
		fingerprint: string
	): Promise<ItemOutcome> {
		const payload = await fetchArticlePayload(ctx, item);
		return writeArticleNote(ctx, { item, fingerprint, ...payload });
	}
}

export interface ArticlePayload {
	detail: LinkReadingDetail | FileReadingDetail;
	summary: ReadingSummary | null;
	highlights: HighlightItem[];
	comments: CommentItem[];
}

export interface ArticleNoteInput extends ArticlePayload {
	item: ReadingItem;
	fingerprint: string;
}

/**
 * 一篇文章渲染所需的全部远端数据；同步与「划词后立刻刷新这一篇」共用。
 * 已经拿到详情的调用方（刷新路径靠它反推 resource_type）可以直接传进来，省一次请求。
 */
export async function fetchArticlePayload(
	ctx: SyncContext,
	item: Pick<ReadingItem, "id" | "resource_type">,
	fetched?: LinkReadingDetail | FileReadingDetail
): Promise<ArticlePayload> {
	const { client } = ctx;
	const [detail, summary, highlights, comments] = await Promise.all([
		fetched ??
			(item.resource_type === "file"
				? client.getFileDetail(item.id)
				: client.getLinkDetail(item.id)),
		item.resource_type === "file" ? null : client.getSummary(item.id).catch(() => null),
		client.listHighlightsByReading(item.id),
		client.listCommentsByReading(item.id)
	]);
	return { detail, summary, highlights, comments };
}

/**
 * 渲染并写入一篇文章笔记，同时把它的高亮批次交给 HighlightSyncer。
 * 同步流程与划词写回后的单篇刷新共用同一条路径 —— 正文锚点、高亮笔记、记账口径只有一份实现。
 */
export async function writeArticleNote(
	ctx: SyncContext,
	input: ArticleNoteInput
): Promise<ItemOutcome> {
	const { store, settings, vaultGateway } = ctx;
	const { item, detail, summary, highlights, comments, fingerprint } = input;

	const baseName = articleBaseName(item);
	const prev = store.getArticle(item.id);
	const relative = storedRelativePath(vaultGateway, prev?.path, `Articles/${baseName}.md`);

	if (prev && settings.onEditedManaged === "skip") {
		const current = await vaultGateway.readManagedHash(relative);
		if (current !== null && prev.managedHash && current !== prev.managedHash) {
			ctx.notice(`Puzle Read：文章「${item.title ?? item.id}」managed 区有本地修改，已跳过`);
			return "skipped";
		}
	}

	// 后端正文是 HTML，先转成 Markdown 再注入锚点/写入笔记
	let body = normalizeArticleContent(detail.content);
	if (settings.injectAnchors) {
		const anchors: AnchorHighlight[] = highlights
			.filter(
				(highlight) =>
					!highlight.hidden &&
					typeof highlight.content === "string" &&
					highlight.content.trim().length > 0
			)
			.map((highlight) => ({
				id: highlight.id,
				content: highlight.content as string,
				start_index: highlight.location_data?.start_index ?? 0,
				linkTarget: `${sanitizeFileName(item.title ?? "")} h${highlight.id}`
			}));
		body = injectAnchors(body, anchors).markdown;
	}

	const articleComments = sortComments(
		comments.filter(
			(comment) => comment.highlight_id === null || comment.highlight_id === undefined
		)
	);
	const managed = renderArticleManaged({
		content: body,
		summary,
		articleComments,
		rootFolder: vaultGateway.root
	});
	// 会话绑定以服务端为准，服务端还没记上时保留本地刚绑的那个，别被 null 冲掉
	const chatId = detail.chat_id ?? item.chat_id ?? prev?.chatId ?? null;
	const file = await vaultGateway.writeManaged(
		relative,
		articleFrontmatter(detail, ctx.now, chatId),
		managed
	);
	const managedHash = (await vaultGateway.readManagedHash(relative)) ?? hashManaged(managed);

	store.setArticle(item.id, {
		path: file.path,
		fingerprint,
		managedHash,
		syncedAt: ctx.now,
		chatId,
		// 记下来源类型，「刷新这一篇」才知道该调 link 还是 file 详情接口
		resourceType: item.resource_type === "file" ? "file" : "link"
	});

	shareHighlightBatch(ctx, item, baseName, highlights, comments);
	return prev ? "updated" : "created";
}

function shareHighlightBatch(
	ctx: SyncContext,
	item: ReadingItem,
	baseName: string,
	highlights: HighlightItem[],
	comments: CommentItem[]
): void {
	const { shared } = ctx;
	const commentsByHighlight = new Map<number, CommentItem[]>();
	for (const comment of comments) {
		if (typeof comment.highlight_id !== "number") continue;
		const list = commentsByHighlight.get(comment.highlight_id) ?? [];
		list.push(comment);
		commentsByHighlight.set(comment.highlight_id, list);
	}

	const ids = new Set<number>();
	for (const highlight of highlights) {
		ids.add(highlight.id);
		shared.highlightJobs.push({
			readingId: item.id,
			articleTitle: item.title ?? "",
			articleBaseName: baseName,
			highlight,
			comments: sortComments(commentsByHighlight.get(highlight.id) ?? [])
		});
	}
	shared.remoteHighlightIds.set(item.id, ids);
}
