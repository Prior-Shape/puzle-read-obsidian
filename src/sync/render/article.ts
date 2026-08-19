import type { CommentItem, ReadingItem, ReadingSummary } from "../../core/models";

export const SUMMARY_CATEGORY_LABELS: Array<{ key: keyof ReadingSummary; label: string }> = [
	{ key: "key_points", label: "关键要点" },
	{ key: "new_knowledge", label: "新知识" },
	{ key: "different_opinions", label: "不同观点" },
	{ key: "related_information", label: "相关信息" }
];

export function formatTime(iso: string | null | undefined): string {
	if (!iso) return "";
	const match = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
	return match ? `${match[1]} ${match[2]}` : iso;
}

export function roleLabel(role: string | null | undefined): string {
	return role === "assistant" ? "🤖 Puzle" : "🙋 我";
}

export function renderCommentLine(comment: CommentItem): string {
	const content = (comment.content ?? "").split("\n").join("\n  ");
	const time = formatTime(comment.created_at);
	const suffix = time ? `${roleLabel(comment.role)} · ${time}` : roleLabel(comment.role);
	return `- ${content}（${suffix}）`;
}

export function sortComments<T extends { created_at: string }>(comments: T[]): T[] {
	return comments.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function renderSummaryCallout(summary: ReadingSummary | null): string | null {
	if (!summary) return null;
	const lines: string[] = [];
	for (const { key, label } of SUMMARY_CATEGORY_LABELS) {
		const items = (summary[key] ?? []).filter(
			(item): item is string => typeof item === "string" && item.trim().length > 0
		);
		if (items.length === 0) continue;
		lines.push(`> **${label}**`);
		for (const item of items) {
			item.split("\n").forEach((part, index) => {
				lines.push(index === 0 ? `> - ${part}` : `>   ${part}`);
			});
		}
	}
	if (lines.length === 0) return null;
	return ["> [!abstract] 核心观点", ...lines].join("\n");
}

export function renderArticleBaseBlock(rootFolder: string): string {
	return `filters:
  and:
    - file.inFolder("${rootFolder}/Highlights")
    - file.hasLink(this.file)
views:
  - type: table
    name: 本文高亮
    order: [file.name, note.category, note.created]`;
}

export interface RenderArticleManagedInput {
	content: string;
	summary: ReadingSummary | null;
	articleComments: CommentItem[];
	rootFolder: string;
}

export function renderArticleManaged(input: RenderArticleManagedInput): string {
	const sections: string[] = [];
	const articleComments = sortComments(input.articleComments);

	const callout = renderSummaryCallout(input.summary);
	if (callout) sections.push(`## 摘要\n${callout}`);

	const content = input.content.trim();
	if (content.length > 0) sections.push(`## 正文\n${content}`);

	if (articleComments.length > 0) {
		sections.push(`## 想法\n${articleComments.map(renderCommentLine).join("\n")}`);
	}

	sections.push(`## 高亮\n\n\`\`\`base\n${renderArticleBaseBlock(input.rootFolder)}\n\`\`\``);

	return sections.join("\n\n");
}

export function articleFrontmatter(
	item: ReadingItem,
	syncedAt: string,
	chatId: number | null = item.chat_id ?? null
): Record<string, unknown> {
	return {
		puzle_type: "article",
		reading_id: item.id,
		puzle_id: item.puzle_id,
		chat_id: chatId,
		title: item.title ?? "",
		url: item.url ?? null,
		author: item.author ?? null,
		domain: item.domain ?? "",
		status: item.status ?? null,
		topics: (item.topics ?? []).map((topic) => topic.title),
		created: item.created_time,
		synced: syncedAt,
		highlight_count: item.highlight_count ?? 0,
		comment_count: item.comment_count ?? 0
	};
}
