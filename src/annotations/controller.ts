import type { PuzleClient } from "../core/api/client";
import type { CommentItem, HighlightItem } from "../core/models";
import type { Logger } from "../core/ports";

export interface ArticleRef {
	readingId: number;
	title: string;
	path: string;
}

export interface AnnotationEntry {
	highlight: HighlightItem;
	comments: CommentItem[];
}

export interface AnnotationsState {
	article: ArticleRef | null;
	loading: boolean;
	submitting: boolean;
	error: string | null;
	entries: AnnotationEntry[];
	articleComments: CommentItem[];
}

export type AnnotationsListener = (state: AnnotationsState) => void;

export interface AnnotationsControllerOptions {
	logger?: Logger;
	notice?: (message: string) => void;
	/** 评论写回成功后触发：上层据此刷新文章笔记的 managed 区 */
	onAnnotationsChanged?: (readingId: number) => void;
}

interface CachedAnnotations {
	entries: AnnotationEntry[];
	articleComments: CommentItem[];
}

function emptyState(): AnnotationsState {
	return {
		article: null,
		loading: false,
		submitting: false,
		error: null,
		entries: [],
		articleComments: []
	};
}

export class AnnotationsController {
	private readonly listeners = new Set<AnnotationsListener>();
	private readonly cache = new Map<number, CachedAnnotations>();
	private state: AnnotationsState = emptyState();
	private loadGeneration = 0;
	private disposed = false;

	constructor(
		private readonly getClient: () => PuzleClient,
		private readonly options: AnnotationsControllerOptions = {}
	) {}

	getState(): AnnotationsState {
		return this.state;
	}

	subscribe(listener: AnnotationsListener): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 切换当前文章。命中缓存时先画出来，再按需后台刷新。 */
	async setArticle(article: ArticleRef | null): Promise<void> {
		if (this.disposed) return;
		if (article === null) {
			if (this.state.article === null) return;
			this.loadGeneration += 1;
			this.setState(emptyState());
			return;
		}
		if (this.state.article?.readingId === article.readingId) {
			this.setState({ article });
			return;
		}
		const cached = this.cache.get(article.readingId);
		this.setState({
			article,
			entries: cached?.entries ?? [],
			articleComments: cached?.articleComments ?? [],
			error: null
		});
		if (cached) return;
		await this.load(article.readingId);
	}

	async refresh(): Promise<void> {
		const article = this.state.article;
		if (!article) return;
		this.cache.delete(article.readingId);
		await this.load(article.readingId);
	}

	async addArticleComment(content: string): Promise<boolean> {
		return this.addComment(content, null);
	}

	async addHighlightComment(highlightId: number, content: string): Promise<boolean> {
		return this.addComment(content, highlightId);
	}

	/**
	 * 删除高亮（连带它下面的评论一起消失）。
	 * AI 生成的高亮也照发请求 —— Web 端同样不按 role 拦，能不能删由后端说了算，
	 * 拒绝时把服务端的话原样报出来。
	 */
	async deleteHighlight(highlightId: number): Promise<boolean> {
		return this.mutate(
			(client) => client.deleteHighlight(highlightId),
			"已删除这条高亮",
			"删除高亮失败"
		);
	}

	async deleteComment(commentId: number): Promise<boolean> {
		return this.mutate(
			(client) => client.deleteComment(commentId),
			"已删除这条想法",
			"删除想法失败"
		);
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	private async load(readingId: number): Promise<void> {
		const generation = ++this.loadGeneration;
		const stale = () =>
			this.disposed ||
			generation !== this.loadGeneration ||
			this.state.article?.readingId !== readingId;
		this.setState({ loading: true, error: null });
		try {
			const client = this.getClient();
			const [highlights, comments] = await Promise.all([
				client.listHighlightsByReading(readingId),
				client.listCommentsByReading(readingId)
			]);
			if (stale()) return;
			const grouped = groupAnnotations(highlights, comments);
			this.cache.set(readingId, grouped);
			this.setState({ ...grouped, loading: false });
		} catch (err) {
			if (stale()) return;
			this.options.logger?.error("[annotations] 加载批注失败", err);
			this.setState({ loading: false, error: errorMessage(err) });
		}
	}

	private async addComment(content: string, highlightId: number | null): Promise<boolean> {
		const text = content.trim();
		if (!text) return false;
		const article = this.state.article;
		if (!article) return false;
		return this.mutate(
			(client) =>
				client.createComment({
					reading_id: article.readingId,
					highlight_id: highlightId,
					content: text
				}),
			highlightId === null ? "已发表想法" : "已回复这条高亮",
			"发表失败"
		);
	}

	/** 写回类操作的公共外壳：提交态 → 调接口 → 重新拉取 → 刷新文章笔记 → 提示 */
	private async mutate(
		run: (client: PuzleClient) => Promise<unknown>,
		success: string,
		failPrefix: string
	): Promise<boolean> {
		const article = this.state.article;
		if (!article || this.state.submitting) return false;
		this.setState({ submitting: true, error: null });
		try {
			await run(this.getClient());
			this.cache.delete(article.readingId);
			this.setState({ submitting: false });
			await this.load(article.readingId);
			this.options.onAnnotationsChanged?.(article.readingId);
			this.options.notice?.(success);
			return true;
		} catch (err) {
			this.options.logger?.error(`[annotations] ${failPrefix}`, err);
			this.setState({ submitting: false, error: errorMessage(err) });
			this.options.notice?.(`${failPrefix}：${errorMessage(err)}`);
			return false;
		}
	}

	private setState(patch: Partial<AnnotationsState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of [...this.listeners]) {
			try {
				listener(this.state);
			} catch (err) {
				this.options.logger?.error("[annotations] state listener error", err);
			}
		}
	}
}

/**
 * 高亮按正文顺序排列，评论按 highlight_id 归位；
 * highlight_id 为空的是文章级评论，挂不上任何高亮的孤儿评论也并进文章级，避免丢内容。
 */
export function groupAnnotations(
	highlights: HighlightItem[],
	comments: CommentItem[]
): CachedAnnotations {
	const visible = highlights
		.filter((highlight) => !highlight.hidden)
		.slice()
		.sort((a, b) => startIndex(a) - startIndex(b));
	const byHighlight = new Map<number, CommentItem[]>();
	for (const highlight of visible) byHighlight.set(highlight.id, []);

	const articleComments: CommentItem[] = [];
	for (const comment of comments) {
		const bucket =
			typeof comment.highlight_id === "number" ? byHighlight.get(comment.highlight_id) : undefined;
		if (bucket) bucket.push(comment);
		else articleComments.push(comment);
	}

	const byTime = (a: CommentItem, b: CommentItem) => a.created_at.localeCompare(b.created_at);
	return {
		entries: visible.map((highlight) => ({
			highlight,
			comments: (byHighlight.get(highlight.id) ?? []).sort(byTime)
		})),
		articleComments: articleComments.sort(byTime)
	};
}

function startIndex(highlight: HighlightItem): number {
	const value = highlight.location_data?.start_index;
	return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
