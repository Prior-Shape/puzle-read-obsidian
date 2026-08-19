import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/core/ws/history";
import { mapChatHistoryTurns } from "../../src/core/ws/history";
import type { AgentLogContent } from "../../src/core/ws/types";
import {
	chatFrontmatter,
	describeLog,
	renderAssistantMessage,
	renderChatManaged,
	renderThinkingCallout,
	renderUserMessage
} from "../../src/sync/render/chat";
import { makeItem } from "../helpers/fake-client";

const SYNCED_AT = "2026-07-16T12:00:00Z";

const LOGS: AgentLogContent[] = [
	{ type: "thinking", reasoning: "用户问的是阅读层次，需要拆解四个层次。", marker: "full" },
	{ type: "tool_call", tool_name: "search_articles", tool_args: { query: "阅读层次" }, marker: "full" },
	{ type: "tool_result", tool_name: "search_articles", success: true, display: "命中 3 篇文章", marker: "full" },
	{ type: "observation", environment: "知识库", finding: "《如何阅读一本书》有相关章节", marker: "full" }
];

const MESSAGES: ChatMessage[] = [
	{ id: "user-t1", role: "user", content: "阅读的四个层次是什么？", turnId: "t1" },
	{
		id: "assistant-t1",
		role: "assistant",
		content: "阅读的四个层次：基础阅读、检视阅读、分析阅读、主题阅读。",
		turnId: "t1",
		logs: LOGS
	},
	{ id: "user-t2", role: "user", content: "第二层\n展开讲讲？", turnId: "t2" },
	{
		id: "assistant-t2",
		role: "assistant",
		content: "检视阅读是在有限时间内抓住全书骨架的阅读方式。",
		turnId: "t2"
	}
];

describe("chatFrontmatter", () => {
	it("matches the TECH_SPEC 3.4 field set", () => {
		const item = makeItem({
			id: 501,
			resource_type: "chat",
			chat_id: 214,
			puzle_id: 1727,
			title: "关于阅读层次的讨论",
			created_time: "2026-03-18T14:46:40Z"
		});
		const fm = chatFrontmatter(item, "关于阅读层次的讨论", SYNCED_AT, 214);
		expect(fm).toMatchSnapshot();
		expect(Object.keys(fm)).toEqual(["puzle_type", "chat_id", "puzle_id", "title", "created", "synced"]);
	});

	it("falls back to defaults for missing optional fields", () => {
		const item = makeItem({ id: 502, resource_type: "chat", chat_id: null, title: null });
		expect(chatFrontmatter(item, "", SYNCED_AT, 502)).toMatchSnapshot();
	});

	// 生产环境 chat 条目不返回 chat_id，会话 id 来自 resource_id
	it("writes the resolved chat id even when the item has no chat_id", () => {
		const item = makeItem({ id: 762, resource_id: 762, resource_type: "chat", chat_id: null });
		expect(chatFrontmatter(item, "标题", SYNCED_AT, 762).chat_id).toBe(762);
	});
});

describe("renderChatManaged", () => {
	it("omits thinking/tool logs when keepThinking is off", () => {
		const managed = renderChatManaged({ messages: MESSAGES, keepThinking: false });
		expect(managed).toMatchSnapshot();
		expect(managed).not.toContain("[!note]");
		expect(managed).not.toContain("拆解四个层次");
	});

	it("renders thinking/tool logs as a collapsed callout when keepThinking is on", () => {
		const managed = renderChatManaged({ messages: MESSAGES, keepThinking: true });
		expect(managed).toMatchSnapshot();
		expect(managed).toContain("> [!note]- 🧠 思考过程");
		expect(managed).toContain("拆解四个层次");
	});

	it("renders each message as an H2 heading: 用户内容引用块、assistant 内容原样", () => {
		const managed = renderChatManaged({ messages: MESSAGES, keepThinking: false });
		expect(managed).toContain("## 🙋 我\n\n> 阅读的四个层次是什么？");
		expect(managed).toContain("> 第二层\n> 展开讲讲？");
		expect(managed).toContain(
			"## 🤖 Puzle\n\n阅读的四个层次：基础阅读、检视阅读、分析阅读、主题阅读。"
		);
	});

	it("renders nothing for an empty session", () => {
		expect(renderChatManaged({ messages: [], keepThinking: true })).toBe("");
	});

	it("renders mapped history turns end to end", () => {
		const messages = mapChatHistoryTurns([
			{
				turn_id: "t1",
				events: [
					{ type: "message", role: "user", detail: [{ type: "text", text: "你好" }] },
					{
						type: "message",
						role: "assistant",
						detail: { type: "text", text: "你好！", marker: "full" }
					}
				]
			}
		]);
		expect(renderChatManaged({ messages, keepThinking: false })).toMatchSnapshot();
	});
});

describe("renderUserMessage / renderAssistantMessage", () => {
	it("returns null for empty user content", () => {
		expect(renderUserMessage({ id: "u", role: "user", content: "  \n", turnId: "t" })).toBeNull();
	});

	it("omits an assistant block that only has logs when keepThinking is off", () => {
		const message: ChatMessage = {
			id: "a",
			role: "assistant",
			content: "",
			turnId: "t",
			logs: [{ type: "thinking", reasoning: "内部推理", marker: "full" }]
		};
		expect(renderAssistantMessage(message, false)).toBeNull();
		expect(renderAssistantMessage(message, true)).toContain("内部推理");
	});
});

describe("renderThinkingCallout", () => {
	it("renders every supported log type", () => {
		const logs: AgentLogContent[] = [
			{ type: "thinking", reasoning: "先拆解问题", conclusion: "分四步回答", marker: "full" },
			{ type: "observation", environment: "浏览器", finding: "页面已加载", marker: "full" },
			{ type: "tool_call", tool_name: "search", tool_args: { q: "阅读" }, marker: "full" },
			{ type: "tool_result", tool_name: "search", success: false, result: "超时", marker: "full" },
			{ type: "error", error_message: "检索失败，改用本地知识", recoverable: true },
			{ type: "text", text: "过渡说明", marker: "full" }
		];
		expect(renderThinkingCallout(logs)).toMatchSnapshot();
	});

	it("returns null when no log yields renderable text", () => {
		expect(renderThinkingCallout([{ type: "thinking", marker: "full" }, { type: "unknown" }])).toBeNull();
	});

	it("keeps multi-line reasoning inside the callout", () => {
		const callout = renderThinkingCallout([
			{ type: "thinking", reasoning: "第一行\n第二行", marker: "full" }
		]);
		expect(callout).toBe("> [!note]- 🧠 思考过程\n> 第一行\n> 第二行");
	});
});

describe("describeLog", () => {
	it("formats tool_call args and tool_result display", () => {
		expect(describeLog({ type: "tool_call", tool_name: "search", tool_args: { q: "阅读" } })).toBe(
			'search({"q":"阅读"})'
		);
		expect(describeLog({ type: "tool_call", tool_name: "noop" })).toBe("noop");
		expect(
			describeLog({ type: "tool_result", tool_name: "search", success: true, display: "命中 3 篇" })
		).toBe("search: 命中 3 篇");
	});

	it("returns empty string for unknown log types", () => {
		expect(describeLog({ type: "mystery" })).toBe("");
	});
});
