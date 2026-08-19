/**
 * Markdown 选区 → 后端纯文本偏移的反向映射。
 *
 * 正文经历了 HTML → Markdown 转换（还插了 `==` 和 💬 角标），逐字对齐不可能；
 * 但两边的「有效字符」（汉字/字母/数字）序列基本一致 —— Markdown 多出来的都是
 * 标点、空白、URL 一类。所以两边都归一化成有效字符序列后做定位：
 * 选中的那段是 Markdown 里第 k 次出现，就取纯文本里第 k 次出现，天然消歧。
 */

const SIGNIFICANT_RE = /[\p{Letter}\p{Number}]/u;

export interface NormalizedText {
	/** 归一化后的有效字符序列（小写） */
	text: string;
	/** text[i] 在原文中的下标；单位由构建方式决定（UTF-16 或 code point） */
	index: number[];
}

/** 按 UTF-16 下标归一化 —— 编辑器给的选区偏移就是 UTF-16。 */
export function normalizeUtf16(source: string): NormalizedText {
	const text: string[] = [];
	const index: number[] = [];
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (!SIGNIFICANT_RE.test(char)) continue;
		text.push(char.toLowerCase());
		index.push(i);
	}
	return { text: text.join(""), index };
}

/** 按 Unicode code point 下标归一化 —— 后端 location_data 用的就是 code point 计数。 */
export function normalizeCodePoints(source: string): NormalizedText {
	const text: string[] = [];
	const index: number[] = [];
	let cp = 0;
	for (const char of source) {
		if (SIGNIFICANT_RE.test(char)) {
			text.push(char.toLowerCase());
			index.push(cp);
		}
		cp += 1;
	}
	return { text: text.join(""), index };
}

export function countOccurrencesBefore(haystack: string, needle: string, position: number): number {
	if (!needle) return 0;
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1 && at < position) {
		count += 1;
		at = haystack.indexOf(needle, at + 1);
	}
	return count;
}

export function nthOccurrence(haystack: string, needle: string, n: number): number {
	if (!needle) return -1;
	let at = haystack.indexOf(needle);
	let seen = 0;
	let last = at;
	while (at !== -1) {
		if (seen === n) return at;
		last = at;
		seen += 1;
		at = haystack.indexOf(needle, at + 1);
	}
	// 纯文本里的出现次数比 Markdown 少（转换时有内容被合并/丢弃）时退到最后一次
	return last;
}

export interface LocatedRange {
	/** code point 计数，闭开区间，与后端 location_data 口径一致 */
	start_index: number;
	end_index: number;
}

/**
 * 把 Markdown 中 [selectionStart, selectionEnd) 的选区映射到纯文本偏移。
 * 选区里没有任何有效字符（纯符号/空白）时返回 null —— 这种高亮没有定位意义。
 */
export function locateSelection(
	markdown: string,
	selectionStart: number,
	selectionEnd: number,
	plaintext: string
): LocatedRange | null {
	const md = normalizeUtf16(markdown);
	if (!md.text) return null;

	let from = -1;
	let to = -1;
	for (let i = 0; i < md.index.length; i++) {
		const at = md.index[i];
		if (at >= selectionStart && from === -1) from = i;
		if (at < selectionEnd) to = i;
	}
	if (from === -1 || to < from) return null;

	const needle = md.text.slice(from, to + 1);
	const occurrence = countOccurrencesBefore(md.text, needle, from);

	const pt = normalizeCodePoints(plaintext);
	if (!pt.text) return null;
	const found = nthOccurrence(pt.text, needle, occurrence);
	if (found === -1) return null;

	const last = found + needle.length - 1;
	if (last >= pt.index.length) return null;
	return { start_index: pt.index[found], end_index: pt.index[last] + 1 };
}
