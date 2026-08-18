// 后端 /reading/link|file/{id} 的 content 字段返回的是 HTML（不是 Markdown），
// 这里把它转成 Markdown 再写进笔记：保证正文可读、可搜索，且高亮锚点注入
// （按纯文本匹配）能正常工作。纯 TS 实现，不依赖 DOM，便于单测。

const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "input", "source", "col", "area"]);

const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "div", "dl", "dd", "dt", "fieldset",
	"figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
	"header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
	"tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);

const DROPPED_TAGS = new Set(["script", "style", "noscript", "svg", "iframe", "head", "template"]);

// 这些标签遇到同名开标签时隐式闭合上一个；边界是列表/表格容器，避免跨层误闭合
const IMPLICIT_CLOSE_TAGS = new Set(["p", "li", "td", "th", "tr"]);
const LIST_CONTAINER_TAGS = new Set(["ul", "ol", "blockquote"]);

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	middot: "·", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
	ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
	times: "×", divide: "÷", copy: "©", reg: "®", trade: "™", deg: "°",
	larr: "←", rarr: "→", harr: "↔", bull: "•", dagger: "†", permil: "‰"
};

export function decodeEntities(input: string): string {
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body[0] === "#") {
			const isHex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
			try {
				return String.fromCodePoint(code);
			} catch {
				return whole;
			}
		}
		const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
		return named ?? whole;
	});
}

interface ElementNode {
	kind: "element";
	tag: string;
	attrs: Record<string, string>;
	children: Node[];
}
interface TextNode {
	kind: "text";
	text: string;
}
type Node = ElementNode | TextNode;

function parseAttributes(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		const value = m[3] ?? m[4] ?? m[5] ?? "";
		attrs[m[1].toLowerCase()] = decodeEntities(value);
	}
	return attrs;
}

/** 把 HTML 解析成节点树；容忍未闭合标签与错配闭合。 */
export function parseHtml(html: string): ElementNode {
	const root: ElementNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
	const stack: ElementNode[] = [root];
	const pushText = (text: string): void => {
		if (!text) return;
		stack[stack.length - 1].children.push({ kind: "text", text });
	};

	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			pushText(decodeEntities(html.slice(i)));
			break;
		}
		if (lt > i) pushText(decodeEntities(html.slice(i, lt)));

		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
			const end = html.indexOf(">", lt);
			i = end === -1 ? html.length : end + 1;
			continue;
		}

		const gt = html.indexOf(">", lt);
		if (gt === -1) {
			pushText(decodeEntities(html.slice(lt)));
			break;
		}
		const inner = html.slice(lt + 1, gt).trim();
		i = gt + 1;
		if (!inner) continue;

		if (inner[0] === "/") {
			const tag = inner.slice(1).trim().toLowerCase();
			// 就近匹配：找到最近的同名开标签并闭合到它为止
			for (let s = stack.length - 1; s > 0; s--) {
				if (stack[s].tag === tag) {
					stack.length = s;
					break;
				}
			}
			continue;
		}

		const selfClosing = inner.endsWith("/");
		const body = selfClosing ? inner.slice(0, -1) : inner;
		const spaceAt = body.search(/\s/);
		const tag = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
		const attrs = spaceAt === -1 ? {} : parseAttributes(body.slice(spaceAt));

		if (DROPPED_TAGS.has(tag)) {
			// 跳过整段内容
			const closeRe = new RegExp(`</\\s*${tag}\\s*>`, "i");
			const rest = html.slice(i);
			const m = closeRe.exec(rest);
			i = m ? i + m.index + m[0].length : html.length;
			continue;
		}

		// <li>/<p>/<td> 等隐式闭合：遇到同类标签时先关掉上一个，再挂到正确的父节点上
		if (IMPLICIT_CLOSE_TAGS.has(tag)) {
			for (let s = stack.length - 1; s > 0; s--) {
				if (stack[s].tag === tag) {
					stack.length = s;
					break;
				}
				if (LIST_CONTAINER_TAGS.has(stack[s].tag) || stack[s].tag === "table") break;
			}
		}

		const node: ElementNode = { kind: "element", tag, attrs, children: [] };
		stack[stack.length - 1].children.push(node);
		if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
	}
	return root;
}

/** 判断内容是否是 HTML（后端可能在不同环境返回 Markdown）。 */
export function looksLikeHtml(content: string): boolean {
	if (!content) return false;
	const head = content.trimStart().slice(0, 2000);
	if (/^<(div|p|h[1-6]|article|section|ul|ol|table|body|html)\b/i.test(head)) return true;
	const tagCount = (content.match(/<\/(p|div|li|h[1-6]|td|tr|strong|em|span|ul|ol|table)>/gi) ?? []).length;
	return tagCount >= 3;
}

interface RenderCtx {
	listStack: Array<{ ordered: boolean; index: number }>;
	inPre: boolean;
}

// 只转义会真正改变 Markdown 语义的字符；不转义 `_`，避免 snake_case 满屏反斜杠
const INLINE_ESCAPE_RE = /([\\`*[\]])/g;
// 段首出现这些字符会被解析成块级语法（标题/列表/引用等），需要转义
const LEADING_BLOCK_RE = /^(\s*)([#>+-]|\d+[.)])(\s)/;

function escapeInline(text: string): string {
	return text.replace(INLINE_ESCAPE_RE, "\\$1");
}

function escapeLeadingBlock(text: string): string {
	return text.replace(LEADING_BLOCK_RE, (_m, space: string, token: string, tail: string) => {
		// 有序列表标记转义点号（1\.），其余在字符前加反斜杠（\#、\-、\>）
		const escaped = /^\d/.test(token) ? token.replace(/([.)])$/, "\\$1") : `\\${token}`;
		return `${space}${escaped}${tail}`;
	});
}

function collapseWs(text: string): string {
	return text.replace(/[ \t\r\n]+/g, " ");
}

function renderChildren(node: ElementNode, ctx: RenderCtx): string {
	return node.children.map((child) => renderNode(child, ctx)).join("");
}

/** 行内渲染：返回单行文本（换行会被压平）。 */
function renderInline(node: ElementNode, ctx: RenderCtx): string {
	return collapseWs(renderChildren(node, ctx)).trim();
}

function blockSeparator(text: string): string {
	return text.length > 0 ? `${text}\n\n` : "";
}

function renderTable(node: ElementNode, ctx: RenderCtx): string {
	const rows: string[][] = [];
	let headerCount = 0;
	const walk = (el: ElementNode, inHead: boolean): void => {
		for (const child of el.children) {
			if (child.kind !== "element") continue;
			if (child.tag === "thead") walk(child, true);
			else if (child.tag === "tbody" || child.tag === "tfoot") walk(child, false);
			else if (child.tag === "tr") {
				const cells: string[] = [];
				let allTh = true;
				for (const cell of child.children) {
					if (cell.kind !== "element") continue;
					if (cell.tag !== "td" && cell.tag !== "th") continue;
					if (cell.tag !== "th") allTh = false;
					cells.push(renderInline(cell, ctx).replace(/\|/g, "\\|"));
				}
				if (cells.length === 0) continue;
				rows.push(cells);
				if ((inHead || allTh) && rows.length === headerCount + 1) headerCount = rows.length;
			} else walk(child, inHead);
		}
	};
	walk(node, false);
	if (rows.length === 0) return "";

	const width = Math.max(...rows.map((r) => r.length));
	const pad = (r: string[]): string[] => [...r, ...Array(width - r.length).fill("")];
	const header = headerCount > 0 ? pad(rows[0]) : Array(width).fill("");
	const bodyRows = headerCount > 0 ? rows.slice(1) : rows;
	const lines = [
		`| ${header.join(" | ")} |`,
		`| ${Array(width).fill("---").join(" | ")} |`,
		...bodyRows.map((r) => `| ${pad(r).join(" | ")} |`)
	];
	return blockSeparator(lines.join("\n"));
}

/**
 * 列表按「相对缩进」递归渲染：每层只输出自己的标记，子层内容整体缩进 4 空格。
 * 这样任意嵌套深度的缩进都由递归自然叠加，不需要维护绝对深度。
 */
function renderList(node: ElementNode, ctx: RenderCtx): string {
	const ordered = node.tag === "ol";
	const startAttr = Number.parseInt(node.attrs.start ?? "", 10);
	ctx.listStack.push({ ordered, index: Number.isFinite(startAttr) ? startAttr : 1 });
	const nested = ctx.listStack.length > 1;
	const items: string[] = [];

	for (const child of node.children) {
		if (child.kind !== "element" || child.tag !== "li") continue;
		const frame = ctx.listStack[ctx.listStack.length - 1];
		const marker = ordered ? `${frame.index}. ` : "- ";
		frame.index += 1;

		const raw = renderChildren(child, ctx).replace(/\n{3,}/g, "\n\n").trim();
		if (!raw) continue;
		const [first, ...rest] = raw.split("\n");
		const lines = [
			`${marker}${first}`,
			...rest.map((line) => (line.trim() ? `    ${line}` : ""))
		];
		items.push(lines.join("\n"));
	}
	ctx.listStack.pop();
	if (items.length === 0) return "";
	const joined = items.join("\n");
	// 嵌套列表前后各留一个换行，让父级 <li> 能把它识别为独立的续行块
	return nested ? `\n${joined}\n` : blockSeparator(joined);
}

function renderNode(node: Node, ctx: RenderCtx): string {
	if (node.kind === "text") {
		if (ctx.inPre) return node.text;
		return escapeInline(collapseWs(node.text));
	}

	switch (node.tag) {
		case "#root":
			return renderChildren(node, ctx);

		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const level = Number(node.tag[1]);
			const text = renderInline(node, ctx);
			return text ? blockSeparator(`${"#".repeat(level)} ${text}`) : "";
		}

		case "p": {
			const text = renderInline(node, ctx);
			return blockSeparator(escapeLeadingBlock(text));
		}

		case "br":
			return "\n";

		case "hr":
			return blockSeparator("---");

		case "strong":
		case "b": {
			const text = renderInline(node, ctx);
			return text ? `**${text}**` : "";
		}

		case "em":
		case "i": {
			const text = renderInline(node, ctx);
			return text ? `*${text}*` : "";
		}

		case "del":
		case "s":
		case "strike": {
			const text = renderInline(node, ctx);
			return text ? `~~${text}~~` : "";
		}

		case "code": {
			if (ctx.inPre) return renderChildren(node, ctx);
			// 行内代码里不做 Markdown 转义，按需加长反引号栅栏
			const text = collapseWs(rawText(node)).trim();
			if (!text) return "";
			const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
			const fence = "`".repeat(longest + 1);
			const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
			return `${fence}${padding}${text}${padding}${fence}`;
		}

		case "pre": {
			const prev = ctx.inPre;
			ctx.inPre = true;
			const text = rawText(node).replace(/^\n+/, "").replace(/\s+$/, "");
			ctx.inPre = prev;
			if (!text) return "";
			const lang = detectLang(node);
			return blockSeparator(`\`\`\`${lang}\n${text}\n\`\`\``);
		}

		case "blockquote": {
			const inner = renderChildren(node, ctx).trim();
			if (!inner) return "";
			const quoted = inner
				.split("\n")
				.map((line) => (line.trim() ? `> ${line}` : ">"))
				.join("\n");
			return blockSeparator(quoted);
		}

		case "ul":
		case "ol":
			return renderList(node, ctx);

		case "table":
			return renderTable(node, ctx);

		case "a": {
			const text = renderInline(node, ctx);
			const href = (node.attrs.href ?? "").trim();
			if (!text) return "";
			if (!href || href.startsWith("javascript:")) return text;
			return `[${text}](${encodeUrl(href)})`;
		}

		case "img": {
			const src = (node.attrs.src ?? "").trim();
			if (!src) return "";
			const alt = (node.attrs.alt ?? "").replace(/[[\]]/g, "");
			return `![${alt}](${encodeUrl(src)})`;
		}

		default:
			// div/span/section/li 之外的未知标签：透传子节点
			if (BLOCK_TAGS.has(node.tag)) {
				const inner = renderChildren(node, ctx).trim();
				return blockSeparator(inner);
			}
			return renderChildren(node, ctx);
	}
}

function rawText(node: ElementNode): string {
	let out = "";
	const walk = (n: Node): void => {
		if (n.kind === "text") out += n.text;
		else if (n.tag === "br") out += "\n";
		else n.children.forEach(walk);
	};
	node.children.forEach(walk);
	return out;
}

function detectLang(node: ElementNode): string {
	const codeChild = node.children.find(
		(c): c is ElementNode => c.kind === "element" && c.tag === "code"
	);
	const cls = `${node.attrs.class ?? ""} ${codeChild?.attrs.class ?? ""}`;
	const m = cls.match(/language-([a-zA-Z0-9+#-]+)/);
	return m ? m[1] : "";
}

function encodeUrl(url: string): string {
	return url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** HTML 正文 → Markdown。 */
export function htmlToMarkdown(html: string): string {
	if (!html) return "";
	const tree = parseHtml(html);
	const ctx: RenderCtx = { listStack: [], inPre: false };
	const md = renderNode(tree, ctx);
	return md
		.replace(/ /g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 内容是 HTML 就转换，已经是 Markdown 就原样返回。 */
export function normalizeArticleContent(content: string | null | undefined): string {
	const raw = content ?? "";
	if (!raw.trim()) return "";
	return looksLikeHtml(raw) ? htmlToMarkdown(raw) : raw;
}
