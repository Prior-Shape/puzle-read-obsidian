import type { PuzleClient } from "../core/api/client";
import type { HighlightItem, ReadingItem } from "../core/models";
import { htmlToPlainText, PLAINTEXT_VARIANTS, sliceByCodePoints } from "./plaintext";
import type { PlaintextVariant } from "./plaintext";
import type { ArticleSourceCache } from "./source";

export interface VariantScore {
	variant: PlaintextVariant;
	/** 切片与 content 完全一致 */
	exact: number;
	/** 忽略首尾空白与空白折叠后一致 */
	loose: number;
	total: number;
}

export interface CalibrationSample {
	html: string;
	highlights: HighlightItem[];
}

export interface CalibrationResult {
	scores: VariantScore[];
	best: VariantScore | null;
	articles: number;
}

function loosen(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * 账号里已有的高亮自带 start_index/end_index 和 content 文本快照，
 * 天然就是标准答案：哪种纯文本口径能让 slice(start,end) 还原出 content，哪种就是后端的口径。
 */
export function scoreVariants(samples: CalibrationSample[]): VariantScore[] {
	const scores: VariantScore[] = [];
	for (const variant of PLAINTEXT_VARIANTS) {
		const score: VariantScore = { variant, exact: 0, loose: 0, total: 0 };
		for (const sample of samples) {
			const plaintext = htmlToPlainText(sample.html, variant);
			for (const highlight of sample.highlights) {
				const content = highlight.content;
				const location = highlight.location_data;
				if (typeof content !== "string" || !content.trim() || !location) continue;
				const { start_index: start, end_index: end } = location;
				if (typeof start !== "number" || typeof end !== "number" || end <= start) continue;
				score.total += 1;
				const sliced = sliceByCodePoints(plaintext, start, end);
				if (sliced === content) score.exact += 1;
				if (loosen(sliced) === loosen(content)) score.loose += 1;
			}
		}
		scores.push(score);
	}
	return scores;
}

export function pickBest(scores: VariantScore[]): VariantScore | null {
	const usable = scores.filter((score) => score.total > 0);
	if (usable.length === 0) return null;
	return usable
		.slice()
		.sort((a, b) => b.exact - a.exact || b.loose - a.loose)[0];
}

export interface CalibrateOptions {
	/** 采样多少篇有高亮的文章 */
	maxArticles?: number;
	onProgress?: (done: number, target: number) => void;
	signal?: AbortSignal;
}

export async function calibrate(
	client: PuzleClient,
	cache: ArticleSourceCache,
	options: CalibrateOptions = {}
): Promise<CalibrationResult> {
	const maxArticles = options.maxArticles ?? 5;
	const samples: CalibrationSample[] = [];

	for await (const item of client.iterateAllReadingItems()) {
		if (options.signal?.aborted) break;
		if (samples.length >= maxArticles) break;
		if (!isSampleCandidate(item)) continue;
		try {
			const [html, highlights] = await Promise.all([
				cache.getHtml(item.id),
				client.listHighlightsByReading(item.id)
			]);
			const usable = highlights.filter(
				(highlight) => typeof highlight.content === "string" && highlight.content.trim().length > 0
			);
			if (!html || usable.length === 0) continue;
			samples.push({ html, highlights: usable });
			options.onProgress?.(samples.length, maxArticles);
		} catch {
			// 单篇失败不影响采样，继续下一篇
		}
	}

	const scores = scoreVariants(samples);
	return { scores, best: pickBest(scores), articles: samples.length };
}

function isSampleCandidate(item: ReadingItem): boolean {
	return (
		(item.resource_type === "link" || item.resource_type === "file") &&
		(item.highlight_count ?? 0) > 0
	);
}

export function formatScores(result: CalibrationResult): string {
	if (result.articles === 0) return "没有采到带高亮的文章，无法校验";
	const lines = result.scores
		.filter((score) => score.total > 0)
		.map(
			(score) =>
				`${score.variant}: 完全一致 ${score.exact}/${score.total}，忽略空白后 ${score.loose}/${score.total}`
		);
	return [`采样 ${result.articles} 篇文章`, ...lines].join("\n");
}
