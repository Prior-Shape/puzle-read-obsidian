import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import { resolveArticleRef } from "../../src/annotations/feature";
import { AnnotationsController } from "../../src/annotations/controller";
import type { PluginDeps } from "../../src/deps";
import type { PuzleClient } from "../../src/core/api/client";

function file(path: string): TFile {
	const f = new TFile();
	f.path = path;
	f.extension = path.split(".").pop() ?? "";
	f.basename = (path.split("/").pop() ?? "").replace(/\.md$/, "");
	return f;
}

function makeApp(frontmatters: Record<string, Record<string, unknown>>): App {
	const files = new Map(Object.keys(frontmatters).map((path) => [path, file(path)]));
	return {
		metadataCache: {
			getFileCache: (target: TFile) => {
				const frontmatter = frontmatters[target.path];
				return frontmatter ? { frontmatter } : null;
			}
		},
		vault: {
			getFileByPath: (path: string) => files.get(path) ?? null
		}
	} as unknown as App;
}

function makeDeps(articles: Record<number, { path: string }>): PluginDeps {
	return {
		getData: () => ({ syncState: { articles } }) as never
	} as unknown as PluginDeps;
}

describe("resolveArticleRef", () => {
	const ARTICLE = "PuzleRead/Articles/如何阅读一本书 (r7).md";
	const HIGHLIGHT = "PuzleRead/Highlights/如何阅读一本书 h11.md";
	const app = makeApp({
		[ARTICLE]: { puzle_type: "article", reading_id: 7, title: "如何阅读一本书" },
		[HIGHLIGHT]: { puzle_type: "highlight", reading_id: 7, highlight_id: 11 },
		"Notes/随手记.md": { tags: ["x"] }
	});
	const deps = makeDeps({ 7: { path: ARTICLE } });

	it("文章笔记直接解析", () => {
		expect(resolveArticleRef(app, file(ARTICLE), deps)).toEqual({
			readingId: 7,
			title: "如何阅读一本书",
			path: ARTICLE
		});
	});

	it("高亮笔记回落到所属文章，面板不会变空", () => {
		expect(resolveArticleRef(app, file(HIGHLIGHT), deps)).toEqual({
			readingId: 7,
			title: "如何阅读一本书",
			path: ARTICLE
		});
	});

	it("不传 deps 时高亮笔记不解析（创建高亮只允许在文章正文里）", () => {
		expect(resolveArticleRef(app, file(HIGHLIGHT))).toBeNull();
	});

	it("同步状态里查不到所属文章时返回 null", () => {
		expect(resolveArticleRef(app, file(HIGHLIGHT), makeDeps({}))).toBeNull();
	});

	it("非 Puzle 笔记、非 md、空文件都返回 null", () => {
		expect(resolveArticleRef(app, file("Notes/随手记.md"), deps)).toBeNull();
		expect(resolveArticleRef(app, file("PuzleRead/x.png"), deps)).toBeNull();
		expect(resolveArticleRef(app, null, deps)).toBeNull();
	});
});

describe("AnnotationsController.setArticle", () => {
	const client = {} as PuzleClient;

	it("已经是空状态时再置空不触发重渲染", async () => {
		const controller = new AnnotationsController(() => client);
		const states: unknown[] = [];
		controller.subscribe((state) => states.push(state));
		expect(states).toHaveLength(1);

		await controller.setArticle(null);
		await controller.setArticle(null);

		expect(states).toHaveLength(1);
	});

	it("同一篇文章重复设置不重新拉数据", async () => {
		let calls = 0;
		const counting = {
			listHighlightsByReading: async () => {
				calls += 1;
				return [];
			},
			listCommentsByReading: async () => []
		} as unknown as PuzleClient;
		const controller = new AnnotationsController(() => counting);

		await controller.setArticle({ readingId: 7, title: "t", path: "a.md" });
		await controller.setArticle({ readingId: 7, title: "t", path: "a.md" });

		expect(calls).toBe(1);
	});
});
