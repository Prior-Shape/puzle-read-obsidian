import { describe, expect, it } from "vitest";
import {
	decodeEntities,
	htmlToMarkdown,
	looksLikeHtml,
	normalizeArticleContent
} from "../../src/sync/render/html";

describe("decodeEntities", () => {
	it("decodes named, decimal and hex entities", () => {
		expect(decodeEntities("a&amp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;")).toBe(`a&b <c> "d" 'e'`);
		expect(decodeEntities("&#20320;&#22909;")).toBe("你好");
		expect(decodeEntities("&#x4F60;&#x597D;")).toBe("你好");
		expect(decodeEntities("&hellip;&mdash;&middot;")).toBe("…—·");
	});

	it("leaves unknown entities untouched", () => {
		expect(decodeEntities("&notarealentity; &amp;")).toBe("&notarealentity; &");
	});
});

describe("looksLikeHtml", () => {
	it("detects the backend's article html", () => {
		expect(looksLikeHtml('<div class="article" id="article"><p>正文</p></div>')).toBe(true);
		expect(looksLikeHtml("<h2>标题</h2><p>一</p><p>二</p>")).toBe(true);
	});

	it("treats markdown and plain text as non-html", () => {
		expect(looksLikeHtml("# 标题\n\n正文段落，含 <不是标签> 的尖括号。")).toBe(false);
		expect(looksLikeHtml("")).toBe(false);
		expect(looksLikeHtml("普通句子")).toBe(false);
	});
});

describe("htmlToMarkdown block structure", () => {
	it("converts headings and paragraphs", () => {
		expect(htmlToMarkdown("<h1>一级</h1><h2>二级</h2><p>段落</p>")).toBe("# 一级\n\n## 二级\n\n段落");
	});

	it("unwraps the article container div", () => {
		expect(htmlToMarkdown('<div class="article" id="article"><p>正文</p></div>')).toBe("正文");
	});

	it("converts unordered and ordered lists", () => {
		expect(htmlToMarkdown("<ul><li>甲</li><li>乙</li></ul>")).toBe("- 甲\n- 乙");
		expect(htmlToMarkdown("<ol><li>甲</li><li>乙</li></ol>")).toBe("1. 甲\n2. 乙");
	});

	it("honours the ol start attribute", () => {
		expect(htmlToMarkdown('<ol start="3"><li>甲</li><li>乙</li></ol>')).toBe("3. 甲\n4. 乙");
	});

	it("indents nested lists", () => {
		const md = htmlToMarkdown("<ul><li>外<ul><li>内</li></ul></li><li>后</li></ul>");
		expect(md).toBe("- 外\n    - 内\n- 后");
	});

	it("converts tables with a header row", () => {
		const md = htmlToMarkdown(
			"<table><thead><tr><th>维度</th><th>A</th></tr></thead><tbody><tr><td>形态</td><td>串行</td></tr></tbody></table>"
		);
		expect(md).toBe("| 维度 | A |\n| --- | --- |\n| 形态 | 串行 |");
	});

	it("escapes pipes inside table cells", () => {
		const md = htmlToMarkdown("<table><tr><th>h</th></tr><tr><td>a|b</td></tr></table>");
		expect(md).toContain("| a\\|b |");
	});

	it("converts blockquote and hr", () => {
		expect(htmlToMarkdown("<blockquote><p>引用</p></blockquote>")).toBe("> 引用");
		expect(htmlToMarkdown("<p>上</p><hr/><p>下</p>")).toBe("上\n\n---\n\n下");
	});

	it("renders br as a line break inside a paragraph", () => {
		expect(htmlToMarkdown("<p>上<br/>下</p>")).toBe("上 下");
	});
});

describe("htmlToMarkdown inline formatting", () => {
	it("converts strong/em/del", () => {
		expect(htmlToMarkdown("<p><strong>粗</strong>和<em>斜</em>和<del>删</del></p>")).toBe(
			"**粗**和*斜*和~~删~~"
		);
	});

	it("converts inline code and widens the fence when needed", () => {
		expect(htmlToMarkdown("<p>用 <code>iss</code> 参数</p>")).toBe("用 `iss` 参数");
		expect(htmlToMarkdown("<p><code>a`b</code></p>")).toBe("``a`b``");
	});

	it("does not escape markdown inside inline code", () => {
		expect(htmlToMarkdown("<p><code>a_b*c</code></p>")).toBe("`a_b*c`");
	});

	it("converts fenced code blocks with language", () => {
		const md = htmlToMarkdown('<pre><code class="language-ts">const a = 1;\nconst b = 2;</code></pre>');
		expect(md).toBe("```ts\nconst a = 1;\nconst b = 2;\n```");
	});

	it("preserves whitespace inside pre", () => {
		expect(htmlToMarkdown("<pre><code>if (x) {\n    y();\n}</code></pre>")).toBe(
			"```\nif (x) {\n    y();\n}\n```"
		);
	});

	it("converts links and images, dropping javascript hrefs", () => {
		expect(htmlToMarkdown('<p><a href="https://e.com/a b">文字</a></p>')).toBe("[文字](https://e.com/a%20b)");
		expect(htmlToMarkdown('<p><a href="javascript:alert(1)">文字</a></p>')).toBe("文字");
		expect(htmlToMarkdown('<img src="https://e.com/i.png" alt="图">')).toBe("![图](https://e.com/i.png)");
	});
});

describe("htmlToMarkdown escaping", () => {
	it("escapes characters that would change markdown meaning", () => {
		expect(htmlToMarkdown("<p>引用 [9-16] 与 *星号* 与反斜杠 \\</p>")).toBe(
			"引用 \\[9-16\\] 与 \\*星号\\* 与反斜杠 \\\\"
		);
	});

	it("does not escape underscores in identifiers", () => {
		expect(htmlToMarkdown("<p>使用 snake_case_name 命名</p>")).toBe("使用 snake_case_name 命名");
	});

	it("escapes leading block syntax so text does not become a heading or list", () => {
		expect(htmlToMarkdown("<p># 不是标题</p>")).toBe("\\# 不是标题");
		expect(htmlToMarkdown("<p>- 不是列表</p>")).toBe("\\- 不是列表");
		expect(htmlToMarkdown("<p>1. 不是有序列表</p>")).toBe("1\\. 不是有序列表");
		expect(htmlToMarkdown("<p>&gt; 不是引用</p>")).toBe("\\> 不是引用");
	});
});

describe("htmlToMarkdown robustness", () => {
	it("drops script/style content", () => {
		expect(htmlToMarkdown("<p>前</p><script>alert(1)</script><style>p{color:red}</style><p>后</p>")).toBe(
			"前\n\n后"
		);
	});

	it("tolerates unclosed and mismatched tags", () => {
		expect(htmlToMarkdown("<p>一<p>二")).toBe("一\n\n二");
		expect(htmlToMarkdown("<ul><li>甲<li>乙</ul>")).toBe("- 甲\n- 乙");
		expect(htmlToMarkdown("<p>文字</div></p>")).toBe("文字");
	});

	it("collapses html whitespace but keeps paragraph separation", () => {
		expect(htmlToMarkdown("<p>  多   空格\n  换行 </p><p>下一段</p>")).toBe("多 空格 换行\n\n下一段");
	});

	it("returns empty string for empty or tag-only input", () => {
		expect(htmlToMarkdown("")).toBe("");
		expect(htmlToMarkdown("<div></div><p></p>")).toBe("");
	});

	it("decodes entities in text and attributes", () => {
		expect(htmlToMarkdown("<p>A&amp;B&nbsp;C</p>")).toBe("A&B C");
		expect(htmlToMarkdown('<p><a href="https://e.com/?a=1&amp;b=2">链</a></p>')).toBe(
			"[链](https://e.com/?a=1&b=2)"
		);
	});
});

describe("normalizeArticleContent", () => {
	it("converts html content", () => {
		expect(normalizeArticleContent('<div class="article"><h2>标题</h2><p>正文</p></div>')).toBe(
			"## 标题\n\n正文"
		);
	});

	it("passes markdown through untouched", () => {
		const md = "# 标题\n\n正文 *强调* 与 [链接](https://e.com)。";
		expect(normalizeArticleContent(md)).toBe(md);
	});

	it("handles null and empty input", () => {
		expect(normalizeArticleContent(null)).toBe("");
		expect(normalizeArticleContent(undefined)).toBe("");
		expect(normalizeArticleContent("   ")).toBe("");
	});
});

describe("real backend sample", () => {
	// 取自生产环境 /api/v1/reading/link/2860 的真实片段
	const sample =
		'<div class="article" id="article"><h2>白宫AI监管框架</h2><p>特朗普政府新规：仅美国闭源模型开发商需在发布前自愿提交政府测试。</p><p><strong>受影响主体</strong>：</p><ul><li><strong>需审查</strong>：Anthropic、OpenAI</li><li><strong>暂豁免</strong>：Meta、Nvidia</li></ul></div>';

	it("produces clean markdown", () => {
		expect(htmlToMarkdown(sample)).toBe(
			[
				"## 白宫AI监管框架",
				"",
				"特朗普政府新规：仅美国闭源模型开发商需在发布前自愿提交政府测试。",
				"",
				"**受影响主体**：",
				"",
				"- **需审查**：Anthropic、OpenAI",
				"- **暂豁免**：Meta、Nvidia"
			].join("\n")
		);
	});

	it("keeps highlight snapshots findable as plain text (anchor matching)", () => {
		const md = htmlToMarkdown(sample);
		expect(md).toContain("仅美国闭源模型开发商需在发布前自愿提交政府测试");
	});
});
