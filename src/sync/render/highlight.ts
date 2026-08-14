import type { CommentItem, HighlightItem } from "../../core/models";
import { renderCommentLine } from "./article";

export function highlightFrontmatter(
	highlight: HighlightItem,
	readingId: number,
	articleBaseName: string
): Record<string, unknown> {
	return {
		puzle_type: "highlight",
		highlight_id: highlight.id,
		reading_id: readingId,
		article: `[[${articleBaseName}]]`,
		category: highlight.category,
		role: highlight.role,
		color: highlight.color ?? null,
		created: highlight.created_at
	};
}

export interface RenderHighlightManagedInput {
	highlight: HighlightItem;
	comments: CommentItem[];
}

export function renderHighlightManaged(input: RenderHighlightManagedInput): string {
	const sections: string[] = [];

	const content = (input.highlight.content ?? "").trim();
	if (content.length > 0) {
		sections.push(
			content
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")
		);
	}

	if (input.comments.length > 0) {
		sections.push(`## 想法\n${input.comments.map(renderCommentLine).join("\n")}`);
	}

	return sections.join("\n\n");
}
