import { describe, expect, it } from "vitest";
import { PuzleClient } from "../../src/core/api/client";
import type { HttpPort, HttpRequestOptions, HttpResponse } from "../../src/core/ports";

class RecordingHttpPort implements HttpPort {
	readonly requests: HttpRequestOptions[] = [];
	response: unknown = { id: 1 };

	async request(opts: HttpRequestOptions): Promise<HttpResponse> {
		this.requests.push(opts);
		return { status: 200, json: { code: 200, data: this.response }, text: "" };
	}

	get last(): HttpRequestOptions {
		return this.requests[this.requests.length - 1];
	}

	body(): Record<string, unknown> {
		return JSON.parse(this.last.body as string) as Record<string, unknown>;
	}
}

function makeClient(http: RecordingHttpPort): PuzleClient {
	return new PuzleClient("https://read-web.puzle.com.cn", "token", http);
}

describe("写接口", () => {
	it("createHighlight 传 reading_id / content / location_data，默认 text 类型", async () => {
		const http = new RecordingHttpPort();
		await makeClient(http).createHighlight({
			reading_id: 101,
			content: "基础阅读",
			location_data: { start_index: 10, end_index: 14 }
		});

		expect(http.last.method).toBe("POST");
		expect(http.last.url).toBe("https://read-web.puzle.com.cn/api/v1/reading/highlights");
		expect(http.body()).toEqual({
			reading_id: 101,
			highlight_type: "text",
			content: "基础阅读",
			location_data: { start_index: 10, end_index: 14 }
		});
	});

	it("createComment 不带 highlight_id 时是文章级评论", async () => {
		const http = new RecordingHttpPort();
		await makeClient(http).createComment({ reading_id: 101, content: "很有启发" });

		expect(http.body()).toEqual({ reading_id: 101, content: "很有启发" });
	});

	it("createComment 带 highlight_id 时挂到高亮上", async () => {
		const http = new RecordingHttpPort();
		await makeClient(http).createComment({ reading_id: 101, highlight_id: 7, content: "回复" });

		expect(http.body()).toMatchObject({ highlight_id: 7 });
	});

	it("删除走 DELETE 且路径带 id", async () => {
		const http = new RecordingHttpPort();
		const client = makeClient(http);
		await client.deleteHighlight(7);
		expect(http.last).toMatchObject({
			method: "DELETE",
			url: "https://read-web.puzle.com.cn/api/v1/reading/highlights/7"
		});
		await client.deleteComment(9);
		expect(http.last).toMatchObject({
			method: "DELETE",
			url: "https://read-web.puzle.com.cn/api/v1/reading/comments/9"
		});
	});
});
