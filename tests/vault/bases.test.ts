import { parseYaml } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	articlesBaseConfig,
	BaseConfig,
	buildArticlesBase,
	buildHighlightsBase,
	highlightsBaseConfig,
} from "../../src/vault/bases";

describe("buildArticlesBase", () => {
	it("produces YAML parseable by parseYaml", () => {
		const parsed = parseYaml<BaseConfig>(buildArticlesBase("PuzleRead"));
		expect(parsed).toBeTypeOf("object");
		expect(Array.isArray(parsed.views)).toBe(true);
	});

	it("round-trips the config object through YAML", () => {
		const config = articlesBaseConfig("PuzleRead");
		expect(parseYaml<BaseConfig>(buildArticlesBase("PuzleRead"))).toEqual(config);
	});

	it("filters by Articles folder and puzle_type", () => {
		const parsed = parseYaml<BaseConfig>(buildArticlesBase("PuzleRead"));
		expect(parsed.filters.and).toEqual([
			'file.inFolder("PuzleRead/Articles")',
			'puzle_type == "article"',
		]);
	});

	it("honours a custom root folder in filters", () => {
		const parsed = parseYaml<BaseConfig>(buildArticlesBase("我的书架"));
		expect(parsed.filters.and[0]).toBe('file.inFolder("我的书架/Articles")');
	});

	it("defines the three spec views in order", () => {
		const parsed = parseYaml<BaseConfig>(buildArticlesBase("PuzleRead"));
		expect(parsed.views).toHaveLength(3);
		expect(parsed.views.map((view) => view.name)).toEqual([
			"全部文章",
			"按主题",
			"最近阅读",
		]);

		const [all, byTopic, recent] = parsed.views;
		expect(all.type).toBe("table");
		expect(all.order).toEqual([
			"file.name",
			"note.author",
			"note.domain",
			"note.status",
			"note.highlight_count",
			"note.created",
		]);

		expect(byTopic.type).toBe("table");
		expect(byTopic.groupBy).toEqual({ property: "note.topics", direction: "ASC" });

		expect(recent.type).toBe("cards");
		expect(recent.sort).toEqual([{ property: "note.created", direction: "DESC" }]);
		expect(recent.limit).toBe(50);
	});
});

describe("buildHighlightsBase", () => {
	it("produces YAML parseable by parseYaml", () => {
		const parsed = parseYaml<BaseConfig>(buildHighlightsBase("PuzleRead"));
		expect(parsed).toBeTypeOf("object");
		expect(Array.isArray(parsed.views)).toBe(true);
	});

	it("round-trips the config object through YAML", () => {
		const config = highlightsBaseConfig("PuzleRead");
		expect(parseYaml<BaseConfig>(buildHighlightsBase("PuzleRead"))).toEqual(config);
	});

	it("filters by Highlights folder and puzle_type", () => {
		const parsed = parseYaml<BaseConfig>(buildHighlightsBase("PuzleRead"));
		expect(parsed.filters.and).toEqual([
			'file.inFolder("PuzleRead/Highlights")',
			'puzle_type == "highlight"',
		]);
	});

	it("defines the three spec views in order", () => {
		const parsed = parseYaml<BaseConfig>(buildHighlightsBase("PuzleRead"));
		expect(parsed.views).toHaveLength(3);
		expect(parsed.views.map((view) => view.name)).toEqual([
			"全部高亮",
			"按分类",
			"按文章",
		]);

		const [all, byCategory, byArticle] = parsed.views;
		expect(all.type).toBe("table");
		expect(all.order).toEqual([
			"file.name",
			"note.article",
			"note.category",
			"note.created",
		]);

		expect(byCategory.type).toBe("table");
		expect(byCategory.groupBy).toEqual({
			property: "note.category",
			direction: "ASC",
		});

		expect(byArticle.type).toBe("table");
		expect(byArticle.groupBy).toEqual({
			property: "note.article",
			direction: "ASC",
		});
	});
});
