import { Notice, TFile } from "obsidian";
import type { App, MarkdownView, Plugin } from "obsidian";
import type { PluginDeps } from "../deps";
import type { ArticleRefresher } from "../sync/article-refresh";
import type { PuzleContextMenu } from "../ui/context-menu";
import { activateLeaf, getActiveMarkdownView } from "../ui/leaf";
import { getSelectionContext } from "../ui/selection";
import type { SelectionContext } from "../ui/selection";
import { AnnotationsController } from "./controller";
import type { ArticleRef } from "./controller";
import { locateSelection } from "./locate";
import { sliceByCodePoints } from "./plaintext";
import { revealSnippet } from "./reveal";
import { ArticleSourceCache } from "./source";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "./view";

export interface AnnotationsFeature {
	getController(): AnnotationsController;
}

export interface AnnotationsHooks {
	askAboutSelection(article: ArticleRef, snippet: string): void;
	contextMenu: PuzleContextMenu;
	/** 写回高亮/评论后刷新那篇文章的笔记 */
	articleRefresher: ArticleRefresher;
}

export function registerAnnotationsFeature(
	plugin: Plugin,
	deps: PluginDeps,
	hooks: AnnotationsHooks
): AnnotationsFeature {
	let controller: AnnotationsController | null = null;
	const sourceCache = new ArticleSourceCache(plugin, deps.getClient);

	const getController = (): AnnotationsController => {
		if (!controller) {
			controller = new AnnotationsController(deps.getClient, {
				logger: deps.logger,
				notice: (message) => {
					new Notice(`Puzle Read：${message}`);
				},
				onAnnotationsChanged: (readingId) => {
					void hooks.articleRefresher.refresh(readingId);
				}
			});
		}
		return controller;
	};

	const currentArticle = (): ArticleRef | null =>
		resolveArticleRef(plugin.app, plugin.app.workspace.getActiveFile(), deps);

	const syncActiveArticle = (): void => {
		void getController().setArticle(currentArticle());
	};

	plugin.registerView(
		VIEW_TYPE_ANNOTATIONS,
		(leaf) =>
			new AnnotationsView(leaf, {
				getController,
				reveal: (snippet) => {
					const article = getController().getState().article;
					if (!article) return;
					const file = plugin.app.vault.getFileByPath(article.path);
					if (!file) return;
					void revealSnippet(plugin.app, file, snippet);
				},
				askAboutSelection: (snippet) => {
					const article = getController().getState().article;
					if (!article) return;
					hooks.askAboutSelection(article, snippet);
				},
				syncActiveArticle
			})
	);

	plugin.addCommand({
		id: "open-puzle-annotations",
		name: "打开批注面板",
		callback: () => {
			void (async () => {
				await activateLeaf(plugin.app, VIEW_TYPE_ANNOTATIONS, "right");
				syncActiveArticle();
			})();
		}
	});

	plugin.addRibbonIcon("highlighter", "Puzle Read: 批注面板", () => {
		void (async () => {
			await activateLeaf(plugin.app, VIEW_TYPE_ANNOTATIONS, "right");
			syncActiveArticle();
		})();
	});

	plugin.addCommand({
		id: "puzle-create-highlight",
		name: "从选中文字创建高亮",
		checkCallback: (checking: boolean) => {
			const view = getActiveMarkdownView(plugin.app);
			if (!view || !resolveArticleRef(plugin.app, view.file)) return false;
			if (checking) return true;
			void createHighlightFromSelection(plugin, deps, hooks, sourceCache, getController(), view);
			return true;
		}
	});

	// 阅读模式与编辑模式共用一份菜单项；选区在菜单弹出时就抓好，点下去时 DOM 选区可能已经没了
	hooks.contextMenu.register(({ view, file, selection }) => {
		if (!resolveArticleRef(plugin.app, file) || !selection) return [];
		return [
			{
				title: "Puzle: 创建高亮",
				icon: "highlighter",
				onClick: () => {
					void createHighlightFromSelection(
						plugin,
						deps,
						hooks,
						sourceCache,
						getController(),
						view,
						selection
					);
				}
			}
		];
	});

	// 面板跟随当前打开的文章；没开面板时也维护状态，打开即是最新的。
	// 布局恢复时视图先于任何 file-open 事件挂载，所以启动后还要补一次。
	plugin.app.workspace.onLayoutReady(() => syncActiveArticle());
	plugin.registerEvent(plugin.app.workspace.on("file-open", () => syncActiveArticle()));
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => syncActiveArticle()));

	plugin.register(() => {
		controller?.dispose();
		controller = null;
	});

	return { getController };
}

/**
 * 选区 → 后端偏移 → POST 高亮。
 * content 直接取纯文本切片而不是用户选中的原文：这样 content 与 start/end 天然自洽，
 * 和 Web 端创建出来的高亮是同一形态，正文里的 Markdown 标记也不会混进快照。
 */
async function createHighlightFromSelection(
	plugin: Plugin,
	deps: PluginDeps,
	hooks: AnnotationsHooks,
	sourceCache: ArticleSourceCache,
	controller: AnnotationsController,
	view: MarkdownView,
	captured?: SelectionContext
): Promise<void> {
	const article = resolveArticleRef(plugin.app, view.file);
	if (!article) return;
	const selection = captured ?? getSelectionContext(view);
	if (!selection) {
		new Notice("Puzle Read：请先选中一段正文");
		return;
	}
	try {
		const variant = deps.getSettings().plaintextVariant;
		const plaintext = await sourceCache.getPlainText(article.readingId, variant);
		if (!plaintext) {
			new Notice("Puzle Read：取不到正文，无法定位高亮");
			return;
		}
		const range = locateSelection(selection.docText, selection.start, selection.end, plaintext);
		if (!range) {
			new Notice("Puzle Read：这段文字在原文里定位不到，换一段试试");
			return;
		}
		const content = sliceByCodePoints(plaintext, range.start_index, range.end_index);
		await deps.getClient().createHighlight({
			reading_id: article.readingId,
			content,
			highlight_type: "text",
			location_data: { start_index: range.start_index, end_index: range.end_index }
		});
		await controller.refresh();
		// 正文里的 ==高亮== 由同步渲染，所以就地重建一次这篇笔记，不必等下次同步
		const refreshed = await hooks.articleRefresher.refresh(article.readingId);
		new Notice(
			refreshed
				? "Puzle Read：高亮已创建，笔记已更新"
				: "Puzle Read：高亮已创建，下次同步后正文里会出现标记"
		);
	} catch (error) {
		new Notice(
			`Puzle Read：创建高亮失败 — ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * 当前该看哪篇文章的批注。
 * 高亮笔记也算 —— 从高亮点进来时面板不该变空，而是继续显示它所属文章的批注。
 */
export function resolveArticleRef(
	app: App,
	file: TFile | null,
	deps?: PluginDeps
): ArticleRef | null {
	if (!file || file.extension !== "md") return null;
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	const readingId = frontmatter?.reading_id;
	if (typeof readingId !== "number" || !Number.isFinite(readingId)) return null;

	if (frontmatter?.puzle_type === "article") {
		const title =
			(typeof frontmatter.title === "string" && frontmatter.title.trim()) || file.basename;
		return { readingId, title, path: file.path };
	}
	if (frontmatter?.puzle_type !== "highlight" || !deps) return null;

	const articlePath = deps.getData().syncState.articles[readingId]?.path;
	if (!articlePath) return null;
	const articleFile = app.vault.getFileByPath(articlePath);
	if (!articleFile) return null;
	const articleFm = app.metadataCache.getFileCache(articleFile)?.frontmatter;
	const title =
		(typeof articleFm?.title === "string" && articleFm.title.trim()) || articleFile.basename;
	return { readingId, title, path: articlePath };
}
