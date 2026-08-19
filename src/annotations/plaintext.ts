import { parseHtml } from "../sync/render/html";
import type { ElementNode, HtmlNode } from "../sync/render/html";

/**
 * 后端高亮的 location_data.start_index / end_index 是「Web 端渲染后正文纯文本的字符偏移」。
 * 这份纯文本的确切口径（是否折叠空白、块之间是否换行）无法从文档确定，
 * 所以这里给出几种候选口径，由「校验高亮定位」命令拿账号里已有的高亮当标准答案自证，
 * 选中的口径记在设置里，之后创建高亮就按它算偏移。
 */
export type PlaintextVariant = "raw" | "blockNewline" | "collapseNewline" | "collapseDoubleNewline";

export const PLAINTEXT_VARIANTS: PlaintextVariant[] = [
	"raw",
	"blockNewline",
	"collapseNewline",
	"collapseDoubleNewline"
];

const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "div", "dl", "dd", "dt", "fieldset",
	"figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
	"header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
	"tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

interface VariantRules {
	collapseWhitespace: boolean;
	blockSeparator: string;
}

const RULES: Record<PlaintextVariant, VariantRules> = {
	raw: { collapseWhitespace: false, blockSeparator: "" },
	blockNewline: { collapseWhitespace: false, blockSeparator: "\n" },
	collapseNewline: { collapseWhitespace: true, blockSeparator: "\n" },
	collapseDoubleNewline: { collapseWhitespace: true, blockSeparator: "\n\n" }
};

/** HTML 正文 → 纯文本（按指定口径）。 */
export function htmlToPlainText(html: string, variant: PlaintextVariant = "raw"): string {
	if (!html) return "";
	const rules = RULES[variant];
	const out: string[] = [];
	walk(parseHtml(html), rules, out);
	const text = out.join("");
	if (!rules.collapseWhitespace) return text;
	// 折叠口径下块边界不留悬空空格，否则偏移会比后端多出几位
	return text
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function walk(node: HtmlNode, rules: VariantRules, out: string[]): void {
	if (node.kind === "text") {
		out.push(rules.collapseWhitespace ? node.text.replace(/[ \t\r\n]+/g, " ") : node.text);
		return;
	}
	const element = node as ElementNode;
	if (element.tag === "br") {
		out.push("\n");
		return;
	}
	const isBlock = element.tag !== "#root" && BLOCK_TAGS.has(element.tag);
	for (const child of element.children) walk(child, rules, out);
	if (isBlock && rules.blockSeparator) out.push(rules.blockSeparator);
}

/** 按 Unicode code point 切片 —— 后端偏移是 code point 计数，不是 UTF-16 单元。 */
export function sliceByCodePoints(text: string, start: number, end: number): string {
	const chars = Array.from(text);
	if (start < 0 || end > chars.length || start > end) return "";
	return chars.slice(start, end).join("");
}

export function codePointLength(text: string): number {
	return Array.from(text).length;
}
