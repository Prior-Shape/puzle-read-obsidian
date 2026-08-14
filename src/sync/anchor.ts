export interface AnchorHighlight {
	id: number | string;
	content: string;
	start_index: number;
	linkTarget: string;
}

export interface InjectAnchorsResult {
	markdown: string;
	misses: AnchorHighlight[];
}

interface Line {
	text: string;
	start: number;
	end: number;
	skipped: boolean;
}

interface AnchorMap {
	text: string;
	starts: number[];
	ends: number[];
	blocks: number[];
}

const WS_RE = /\s/;
const ASCII_PUNCT = /[!-/:-@\[-`{-~]/;
const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/;
const HEADING_RE = /^\s{0,3}(?:>\s*)*#{1,6}(?:\s|$)/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const BLOCKQUOTE_PREFIX_RE = /^[ \t]{0,3}(?:>[ \t]*)*/;

function splitLines(source: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\n") {
			lines.push({ text: source.slice(start, i), start, end: i, skipped: false });
			start = i + 1;
		}
	}
	lines.push({ text: source.slice(start), start, end: source.length, skipped: false });
	return lines;
}

function markFrontmatter(lines: Line[]): void {
	if (lines.length === 0 || lines[0].text.trim() !== "---") return;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		const t = lines[i].text.trim();
		if (t === "---" || t === "...") {
			close = i;
			break;
		}
	}
	const upto = close === -1 ? lines.length - 1 : close;
	for (let i = 0; i <= upto; i++) lines[i].skipped = true;
}

function markFences(lines: Line[]): void {
	let fenceCh = "";
	let fenceLen = 0;
	for (const line of lines) {
		if (line.skipped) continue;
		if (fenceCh) {
			line.skipped = true;
			const c = line.text.trim();
			if (c.length >= fenceLen && Array.from(c).every((x) => x === fenceCh)) {
				fenceCh = "";
			}
			continue;
		}
		const m = line.text.trimStart().match(FENCE_RE);
		if (m) {
			fenceCh = m[1][0];
			fenceLen = m[1].length;
			line.skipped = true;
		}
	}
}

function groupBlocks(lines: Line[]): Line[][] {
	const blocks: Line[][] = [];
	let cur: Line[] = [];
	const flush = (): void => {
		if (cur.length) {
			blocks.push(cur);
			cur = [];
		}
	};
	for (const line of lines) {
		if (line.skipped || line.text.trim() === "" || HR_RE.test(line.text)) {
			flush();
			continue;
		}
		if (HEADING_RE.test(line.text)) {
			flush();
			blocks.push([line]);
			continue;
		}
		cur.push(line);
	}
	flush();
	return blocks;
}

function findBacktickRun(s: string, from: number, n: number): number {
	let i = from;
	while (i < s.length) {
		if (s[i] !== "`") {
			i++;
			continue;
		}
		let m = 0;
		while (i + m < s.length && s[i + m] === "`") m++;
		if (m === n) return i;
		i += m;
	}
	return -1;
}

function findMatching(s: string, from: number, open: string, close: string): number {
	let depth = 0;
	for (let i = from; i < s.length; i++) {
		if (s[i] === open) depth++;
		else if (s[i] === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function buildMap(source: string): AnchorMap {
	const lines = splitLines(source);
	markFrontmatter(lines);
	markFences(lines);
	const blocks = groupBlocks(lines);

	const chars: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	const blockIds: number[] = [];

	let inComment = false;
	let lastWs = true;
	let currentBlock = -1;
	let chunkCps: string[] = [];
	let chunkRanges: Array<[number, number]> = [];

	const flushChunk = (): void => {
		if (chunkCps.length === 0) return;
		const src = chunkCps;
		const ranges = chunkRanges;
		chunkCps = [];
		chunkRanges = [];
		const nfc = Array.from(src.join("").normalize("NFC"));
		const m = src.length;
		const n = nfc.length;
		if (n === 1) {
			chars.push(nfc[0]);
			starts.push(ranges[0][0]);
			ends.push(ranges[m - 1][1]);
			blockIds.push(currentBlock);
			return;
		}
		for (let k = 0; k < n; k++) {
			let idx: number;
			if (n === m) idx = k;
			else if (n < m) idx = k === n - 1 ? m - 1 : k;
			else idx = Math.min(k, m - 1);
			chars.push(nfc[k]);
			starts.push(ranges[idx][0]);
			ends.push(ranges[idx][1]);
			blockIds.push(currentBlock);
		}
	};

	const pushCp = (cp: string, s: number, e: number): void => {
		chunkCps.push(cp);
		chunkRanges.push([s, e]);
		lastWs = false;
	};

	const emitWs = (s: number, e: number): void => {
		if (lastWs) return;
		chunkCps.push(" ");
		chunkRanges.push([s, e]);
		lastWs = true;
	};

	const scanText = (s: string, base: number): void => {
		let i = 0;
		while (i < s.length) {
			if (inComment) {
				if (s[i] === "%" && s[i + 1] === "%") {
					inComment = false;
					i += 2;
				} else {
					i++;
				}
				continue;
			}
			if (s[i] === "%" && s[i + 1] === "%") {
				flushChunk();
				inComment = true;
				i += 2;
				continue;
			}
			const ch = s[i];
			if (ch === "`") {
				let n = 0;
				while (i + n < s.length && s[i + n] === "`") n++;
				const close = findBacktickRun(s, i + n, n);
				flushChunk();
				i = close === -1 ? i + n : close + n;
				continue;
			}
			if (ch === "\\") {
				const next = s[i + 1];
				if (next !== undefined && ASCII_PUNCT.test(next)) {
					pushCp(next, base + i + 1, base + i + 2);
					i += 2;
					continue;
				}
				pushCp("\\", base + i, base + i + 1);
				i++;
				continue;
			}
			if (ch === "!" && s[i + 1] === "[" && s[i + 2] === "[") {
				const close = s.indexOf("]]", i + 3);
				if (close !== -1) {
					flushChunk();
					i = close + 2;
					continue;
				}
			}
			if (ch === "[" && s[i + 1] === "[") {
				const close = s.indexOf("]]", i + 2);
				if (close !== -1) {
					flushChunk();
					const inner = s.slice(i + 2, close);
					const pipe = inner.indexOf("|");
					const keep = pipe === -1 ? inner : inner.slice(pipe + 1);
					const from = base + i;
					const to = base + close + 2;
					for (const cp of Array.from(keep)) pushCp(cp, from, to);
					i = close + 2;
					continue;
				}
			}
			if (ch === "[") {
				const close = findMatching(s, i, "[", "]");
				if (close !== -1 && s[close + 1] === "(") {
					const paren = findMatching(s, close + 1, "(", ")");
					if (paren !== -1) {
						flushChunk();
						scanText(s.slice(i + 1, close), base + i + 1);
						i = paren + 1;
						continue;
					}
				}
				pushCp("[", base + i, base + i + 1);
				i++;
				continue;
			}
			if (ch === "*" || ch === "_") {
				let n = 0;
				while (i + n < s.length && s[i + n] === ch) n++;
				flushChunk();
				i += n;
				continue;
			}
			if (ch === "~" || ch === "=") {
				if (s[i + 1] === ch) {
					flushChunk();
					i += 2;
					continue;
				}
				pushCp(ch, base + i, base + i + 1);
				i++;
				continue;
			}
			if (WS_RE.test(ch)) {
				emitWs(base + i, base + i + 1);
				i++;
				continue;
			}
			const code = s.codePointAt(i) as number;
			const len = code > 0xffff ? 2 : 1;
			pushCp(String.fromCodePoint(code), base + i, base + i + len);
			i += len;
		}
	};

	blocks.forEach((block, bid) => {
		currentBlock = bid;
		if (chars.length > 0) {
			chars.push(" ");
			starts.push(block[0].start);
			ends.push(block[0].start);
			blockIds.push(-1);
		}
		lastWs = true;
		block.forEach((line, li) => {
			const prefix = line.text.match(BLOCKQUOTE_PREFIX_RE);
			const p = prefix ? prefix[0].length : 0;
			scanText(line.text.slice(p), line.start + p);
			if (li < block.length - 1) emitWs(line.end, line.end + 1);
		});
		flushChunk();
		while (
			chars.length > 0 &&
			chars[chars.length - 1] === " " &&
			blockIds[blockIds.length - 1] === bid
		) {
			chars.pop();
			starts.pop();
			ends.pop();
			blockIds.pop();
		}
	});

	return { text: chars.join(""), starts, ends, blocks: blockIds };
}

function findAll(text: string, needle: string): number[] {
	const out: number[] = [];
	let i = text.indexOf(needle);
	while (i !== -1) {
		out.push(i);
		i = text.indexOf(needle, i + 1);
	}
	return out;
}

function segmentsOf(map: AnchorMap, lo: number, hi: number): Array<{ lo: number; hi: number }> {
	const segs: Array<{ lo: number; hi: number }> = [];
	let i = lo;
	while (i < hi) {
		if (map.blocks[i] < 0) {
			i++;
			continue;
		}
		const b = map.blocks[i];
		const start = i;
		while (i < hi && map.blocks[i] === b) i++;
		segs.push({ lo: start, hi: i });
	}
	return segs;
}

export function injectAnchors(
	markdown: string,
	highlights: AnchorHighlight[],
): InjectAnchorsResult {
	const map = buildMap(markdown);
	const chosen = new Map<number, [number, number]>();
	const taken: Array<[number, number]> = [];
	const missedIdx: number[] = [];
	const order = highlights
		.map((_, i) => i)
		.sort(
			(a, b) =>
				(highlights[a].start_index || 0) - (highlights[b].start_index || 0) || a - b,
		);

	let cursor = -1;
	for (const i of order) {
		const h = highlights[i];
		const needle = buildMap(typeof h.content === "string" ? h.content : "").text.trim();
		if (!needle) {
			missedIdx.push(i);
			continue;
		}
		const hits = findAll(map.text, needle);
		const avail = hits.filter((p) => {
			const q = p + needle.length;
			return !taken.some(([a, b]) => p < b && q > a);
		});
		if (avail.length === 0) {
			missedIdx.push(i);
			continue;
		}
		const pick = avail.find((p) => p >= cursor) ?? avail[0];
		chosen.set(i, [pick, pick + needle.length]);
		taken.push([pick, pick + needle.length]);
		cursor = pick;
	}

	const insertions: Array<{ pos: number; str: string; rank: number }> = [];
	for (const [i, [lo, hi]] of chosen) {
		const h = highlights[i];
		const segs = segmentsOf(map, lo, hi);
		segs.forEach((seg, si) => {
			const start = map.starts[seg.lo];
			const end = map.ends[seg.hi - 1];
			if (end <= start) return;
			insertions.push({ pos: start, str: "==", rank: 0 });
			insertions.push({
				pos: end,
				str: si === segs.length - 1 ? `== [[${h.linkTarget}|💬]]` : "==",
				rank: 1,
			});
		});
	}

	insertions.sort((a, b) => b.pos - a.pos || a.rank - b.rank);
	let out = markdown;
	for (const ins of insertions) {
		out = out.slice(0, ins.pos) + ins.str + out.slice(ins.pos);
	}

	const missSet = new Set(missedIdx);
	const misses = highlights.filter((_, i) => missSet.has(i));
	return { markdown: out, misses };
}
