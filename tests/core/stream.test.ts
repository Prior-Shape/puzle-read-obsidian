import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMarker, TurnStreamReducer } from "../../src/core/ws/stream";
import type { ChatStreamEvent, UserFrontEvent } from "../../src/core/ws/types";

const SAMPLE_PATH = fileURLToPath(new URL("../fixtures/ws_stream_sample.json", import.meta.url));

function loadSampleFrames(): UserFrontEvent[] {
	return JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as UserFrontEvent[];
}

function ev(partial: Partial<ChatStreamEvent> & { type: string }): ChatStreamEvent {
	return { chat_id: 1, puzle_id: 2, turn_id: "turn_t1", ...partial };
}

const EXPECTED_SAMPLE_TEXT = `我帮你看看最近在Puzle里都关注了些什么：看你最近在关注这些方向：

**国际政治**——特别是中东局势和川普动态。一月份你还读了特朗普对伊朗局势"拭目以待"的文章，评论说伊朗"说话太软、不敢得罪美国"。

**人工智能新应用**——关注AI领域的最新流行趋势。

**产业经济**——今天在读吉林产业转型的文章，还问了东北振兴的最新政策。

看来你最近对国际局势和国内产业经济都挺关注的，是在做相关的研究或投资分析吗？`;

describe("TurnStreamReducer replay of ws_stream_sample.json", () => {
	it("aggregates the full sample stream into the final text and log entries", () => {
		const frames = loadSampleFrames();
		expect(frames).toHaveLength(499);

		const counts: Record<string, number> = {};
		const reducer = new TurnStreamReducer();
		for (const frame of frames) {
			expect(frame.category).toBe("chat");
			const event = frame.event as unknown as ChatStreamEvent;
			counts[event.type] = (counts[event.type] ?? 0) + 1;
			reducer.handle(event);
		}

		expect(counts).toEqual({ turn_start: 1, message: 107, log: 390, turn_end: 1 });

		const state = reducer.snapshot;
		expect(state.status).toBe("done");
		expect(state.chatId).toBe(214);
		expect(state.turnId).toBe("turn_828d285be89639e6");
		expect(state.text).toBe(EXPECTED_SAMPLE_TEXT);
		expect(state.text).toHaveLength(211);
		expect(state.error).toBeNull();

		const byType: Record<string, number> = {};
		for (const log of state.thinkingLogs) byType[log.type] = (byType[log.type] ?? 0) + 1;
		expect(byType).toEqual({ thinking: 2, tool_call: 3, tool_result: 3 });

		const reasoning = state.thinkingLogs
			.filter((log) => log.type === "thinking")
			.map((log) => String(log.reasoning ?? ""));
		expect(reasoning.map((text) => text.length)).toEqual([418, 300]);
		expect(reasoning[0].startsWith("用户问")).toBe(true);
	});
});

describe("marker protocol", () => {
	it.each([
		["started", "hello", "world", "helloworld"],
		["delta", "hello", " world", "hello world"]
	] as const)("appends delta on %s", (marker, buffer, delta, expected) => {
		expect(applyMarker(buffer, marker, delta, "")).toBe(expected);
	});

	it("completed replaces the buffer with the full text", () => {
		expect(applyMarker("partial…", "completed", "", "full answer")).toBe("full answer");
	});

	it("full replaces the buffer with the full text", () => {
		expect(applyMarker("whatever", "full", "", "one-shot")).toBe("one-shot");
	});

	it("hidden clears the buffer", () => {
		expect(applyMarker("让我帮你查一下", "hidden", "", "")).toBe("");
	});

	it("treats marker-less detail with text as full replacement", () => {
		expect(applyMarker("old", undefined, "", "new")).toBe("new");
		expect(applyMarker("old", undefined, "", "")).toBe("old");
	});
});

describe("TurnStreamReducer event handling", () => {
	it("streams text via started/delta and finalizes on completed", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "message", detail: { type: "text", text: "", delta: "这篇", marker: "started" } }));
		reducer.handle(ev({ type: "message", detail: { type: "text", text: "", delta: "文章主要", marker: "delta" } }));
		expect(reducer.snapshot.text).toBe("这篇文章主要");
		expect(reducer.snapshot.status).toBe("streaming");

		reducer.handle(
			ev({ type: "message", detail: { type: "text", text: "这篇文章主要讨论了三个观点", delta: "", marker: "completed" } })
		);
		expect(reducer.snapshot.text).toBe("这篇文章主要讨论了三个观点");

		reducer.handle(ev({ type: "turn_end", status: "ok" }));
		expect(reducer.snapshot.status).toBe("done");
	});

	it("clears intermediate text on hidden before a tool call, then streams the final answer", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "message", detail: { type: "text", delta: "让我", marker: "started" } }));
		reducer.handle(ev({ type: "message", detail: { type: "text", delta: "帮你搜索一下", marker: "delta" } }));
		expect(reducer.snapshot.text).toBe("让我帮你搜索一下");

		reducer.handle(ev({ type: "message", detail: { type: "text", delta: "", marker: "hidden" } }));
		expect(reducer.snapshot.text).toBe("");

		reducer.handle(ev({ type: "log", log: { type: "tool_call", tool_name: "web_search", tool_args: {} } }));
		reducer.handle(ev({ type: "log", log: { type: "tool_result", tool_name: "web_search", success: true } }));
		reducer.handle(ev({ type: "message", detail: { type: "text", delta: "根据搜索", marker: "started" } }));
		reducer.handle(
			ev({ type: "message", detail: { type: "text", delta: "结果，Python 最新版本是 3.13", marker: "delta" } })
		);
		reducer.handle(
			ev({
				type: "message",
				detail: { type: "text", text: "根据搜索结果，Python 最新版本是 3.13", delta: "", marker: "completed" }
			})
		);
		reducer.handle(ev({ type: "turn_end", status: "ok" }));

		const state = reducer.snapshot;
		expect(state.text).toBe("根据搜索结果，Python 最新版本是 3.13");
		expect(state.thinkingLogs.map((log) => log.type)).toEqual(["tool_call", "tool_result"]);
	});

	it("merges streaming thinking logs and keeps tool logs verbatim", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "log", log: { type: "thinking", reasoning: "", delta: "用户", marker: "started" } }));
		reducer.handle(ev({ type: "log", log: { type: "thinking", reasoning: "", delta: "想知道", marker: "delta" } }));
		reducer.handle(
			ev({
				type: "log",
				log: { type: "thinking", reasoning: "用户想知道答案", conclusion: "答案是 42", delta: "", marker: "completed" }
			})
		);
		reducer.handle(ev({ type: "log", log: { type: "tool_call", tool_name: "search", tool_args: {} } }));
		reducer.handle(ev({ type: "log", log: { type: "observation", finding: "", delta: "页面有 3 段", marker: "started" } }));

		const logs = reducer.snapshot.thinkingLogs;
		expect(logs).toHaveLength(3);
		expect(logs[0]).toMatchObject({ type: "thinking", reasoning: "用户想知道答案", conclusion: "答案是 42", marker: "completed" });
		expect(logs[1]).toMatchObject({ type: "tool_call", tool_name: "search" });
		expect(logs[2]).toMatchObject({ type: "observation", finding: "页面有 3 段" });
	});

	it("drops the in-progress log entry of the same type on hidden", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "log", log: { type: "thinking", reasoning: "", delta: "中间想法", marker: "started" } }));
		expect(reducer.snapshot.thinkingLogs).toHaveLength(1);
		reducer.handle(ev({ type: "log", log: { type: "thinking", marker: "hidden" } }));
		expect(reducer.snapshot.thinkingLogs).toHaveLength(0);
	});

	it("records title, task outputs and chat ids", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "title_generated", title: "关于 Python 的讨论" }));
		reducer.handle(
			ev({ type: "task_output", task_id: 42, outputs: [{ resource_type: "reading", resource_id: 456 }] })
		);

		const state = reducer.snapshot;
		expect(state.title).toBe("关于 Python 的讨论");
		expect(state.taskOutputs).toEqual([{ resource_type: "reading", resource_id: 456 }]);
	});

	it("maps turn_end status error and cancelled", () => {
		const errored = new TurnStreamReducer();
		errored.handle(ev({ type: "turn_start" }));
		errored.handle(ev({ type: "turn_end", status: "error", error: "boom" }));
		expect(errored.snapshot.status).toBe("error");
		expect(errored.snapshot.error).toBe("boom");

		const cancelled = new TurnStreamReducer();
		cancelled.handle(ev({ type: "turn_start" }));
		cancelled.handle(ev({ type: "turn_end", status: "cancelled" }));
		expect(cancelled.snapshot.status).toBe("cancelled");
	});

	it("captures turn_end meta (onboarding)", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "turn_end", status: "ok", meta: { onboarded: true } }));
		expect(reducer.snapshot.meta).toEqual({ onboarded: true });
	});

	it("ignores user-role message events and unknown event types", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(
			ev({ type: "message", role: "user", detail: [{ type: "text", text: "用户消息" }] })
		);
		reducer.handle(ev({ type: "subscription_confirmed" }));
		expect(reducer.snapshot.text).toBe("");
		expect(reducer.snapshot.status).toBe("streaming");
	});

	it("reset returns to the idle initial state", () => {
		const reducer = new TurnStreamReducer();
		reducer.handle(ev({ type: "turn_start" }));
		reducer.handle(ev({ type: "message", detail: { type: "text", delta: "x", marker: "started" } }));
		const state = reducer.reset();
		expect(state).toMatchObject({ text: "", thinkingLogs: [], status: "idle", taskOutputs: [] });
	});
});
