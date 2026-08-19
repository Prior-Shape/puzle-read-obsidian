import { MarkdownView } from "obsidian";
import type { App, TFile } from "obsidian";

/** 参与匹配的「有效字符」：汉字、字母、数字。Markdown 标记、空白、标点一律忽略。 */
const SIGNIFICANT_RE = /[\p{Letter}\p{Number}]/u;
const MIN_PREFIX_CHARS = 6;

interface NormalizedDoc {
	text: string;
	/** normalized[i] 对应原文中的行号（0 基） */
	lines: number[];
}

export function normalizeForMatch(source: string): NormalizedDoc {
	let text = "";
	const lines: number[] = [];
	let line = 0;
	for (const char of source) {
		if (char === "\n") {
			line += 1;
			continue;
		}
		if (!SIGNIFICANT_RE.test(char)) continue;
		text += char.toLowerCase();
		lines.push(line);
	}
	return { text, lines };
}

/**
 * 在笔记里找到高亮原文所在的行。
 * 正文经过 HTML→Markdown 转换又插了 `==` 与 💬 角标，逐字比对必然失败，
 * 所以只按有效字符序列匹配；整段匹配不到时退化成前缀匹配（角标可能插在中间）。
 */
export function findSnippetLine(content: string, snippet: string): number | null {
	const doc = normalizeForMatch(content);
	const needle = normalizeForMatch(snippet).text;
	if (!doc.text || !needle) return null;

	let at = doc.text.indexOf(needle);
	// 角标/链接可能插在高亮中间，整段对不上就逐级缩短前缀再试
	let length = needle.length;
	while (at === -1 && length > MIN_PREFIX_CHARS) {
		length = Math.max(MIN_PREFIX_CHARS, Math.floor(length / 2));
		at = doc.text.indexOf(needle.slice(0, length));
	}
	if (at === -1) return null;
	return doc.lines[at] ?? null;
}

/** 打开文章并滚动到这条高亮所在的行；`setEphemeralState` 在编辑/阅读两种模式下都有效。 */
export async function revealSnippet(app: App, file: TFile, snippet: string): Promise<boolean> {
	const content = await app.vault.cachedRead(file);
	const line = findSnippetLine(content, snippet);
	const leaf = findLeafShowing(app, file.path);
	if (leaf) {
		app.workspace.setActiveLeaf(leaf, { focus: true });
	} else {
		await app.workspace.openLinkText(file.path, "", false);
	}
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || line === null) return false;
	view.setEphemeralState({ line });
	return true;
}

function findLeafShowing(app: App, path: string) {
	return (
		app.workspace
			.getLeavesOfType("markdown")
			.find((leaf) => (leaf.view as MarkdownView).file?.path === path) ?? null
	);
}
