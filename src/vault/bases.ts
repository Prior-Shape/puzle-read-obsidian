import { stringifyYaml } from "obsidian";

export interface BaseGroupBy {
	property: string;
	direction: "ASC" | "DESC";
}

export interface BaseSortSpec {
	property: string;
	direction: "ASC" | "DESC";
}

export interface BaseViewConfig {
	type: "table" | "cards" | "list";
	name: string;
	order?: string[];
	groupBy?: BaseGroupBy;
	sort?: BaseSortSpec[];
	limit?: number;
}

export interface BaseConfig {
	filters: { and: string[] };
	views: BaseViewConfig[];
}

export function articlesBaseConfig(rootFolder: string): BaseConfig {
	return {
		filters: {
			and: [
				`file.inFolder("${rootFolder}/Articles")`,
				'puzle_type == "article"',
			],
		},
		views: [
			{
				type: "table",
				name: "全部文章",
				order: [
					"file.name",
					"note.author",
					"note.domain",
					"note.status",
					"note.highlight_count",
					"note.created",
				],
			},
			{
				type: "table",
				name: "按主题",
				groupBy: { property: "note.topics", direction: "ASC" },
			},
			{
				type: "cards",
				name: "最近阅读",
				sort: [{ property: "note.created", direction: "DESC" }],
				limit: 50,
			},
		],
	};
}

export function highlightsBaseConfig(rootFolder: string): BaseConfig {
	return {
		filters: {
			and: [
				`file.inFolder("${rootFolder}/Highlights")`,
				'puzle_type == "highlight"',
			],
		},
		views: [
			{
				type: "table",
				name: "全部高亮",
				order: ["file.name", "note.article", "note.category", "note.created"],
			},
			{
				type: "table",
				name: "按分类",
				groupBy: { property: "note.category", direction: "ASC" },
			},
			{
				type: "table",
				name: "按文章",
				groupBy: { property: "note.article", direction: "ASC" },
			},
		],
	};
}

export function buildArticlesBase(rootFolder: string): string {
	return stringifyYaml(articlesBaseConfig(rootFolder));
}

export function buildHighlightsBase(rootFolder: string): string {
	return stringifyYaml(highlightsBaseConfig(rootFolder));
}
