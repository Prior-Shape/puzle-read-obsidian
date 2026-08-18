import { describe, expect, it } from "vitest";
import {
	ApiError,
	AuthError,
	ITERATE_PAGE_SIZE,
	MAX_ITERATED_ITEMS,
	PuzleClient
} from "../../src/core/api/client";
import type { ReadingItem } from "../../src/core/models";
import type { HttpPort, HttpRequestOptions, HttpResponse } from "../../src/core/ports";

const BASE_URL = "https://read-web-test.puzle.com.cn";
const TOKEN = "test-jwt-token";

function envelope<T>(data: T, code = 0, msg = "ok"): HttpResponse {
	const body = JSON.stringify({ code, data, msg });
	return { status: 200, text: body, json: { code, data, msg } };
}

class MockHttp implements HttpPort {
	readonly requests: HttpRequestOptions[] = [];
	private readonly responders: Array<(opts: HttpRequestOptions) => HttpResponse> = [];
	private fallback?: (opts: HttpRequestOptions) => HttpResponse;

	enqueue(responder: (opts: HttpRequestOptions) => HttpResponse): this {
		this.responders.push(responder);
		return this;
	}

	enqueueEnvelope<T>(data: T, code = 0, msg = "ok"): this {
		return this.enqueue(() => envelope(data, code, msg));
	}

	setFallback(responder: (opts: HttpRequestOptions) => HttpResponse): this {
		this.fallback = responder;
		return this;
	}

	async request(opts: HttpRequestOptions): Promise<HttpResponse> {
		this.requests.push(opts);
		const responder = this.responders.shift() ?? this.fallback;
		if (!responder) throw new Error(`No mock responder queued for ${opts.method ?? "GET"} ${opts.url}`);
		return responder(opts);
	}
}

function makeReadingItem(id: number): ReadingItem {
	return {
		id,
		task_id: id,
		resource_type: "link",
		resource_id: id,
		created_time: "2026-03-18T14:46:40Z",
		highlight_count: 0,
		puzle_id: 1000 + id,
		domain: "example.com"
	};
}

function makeItemsPage(page: number, count: number, total: number) {
	const offset = (page - 1) * ITERATE_PAGE_SIZE;
	return {
		items: Array.from({ length: count }, (_, i) => makeReadingItem(offset + i + 1)),
		total,
		page,
		page_size: ITERATE_PAGE_SIZE
	};
}

function pageParam(url: string): number {
	return Number(new URL(url).searchParams.get("page"));
}

describe("PuzleClient response unwrapping", () => {
	it("sends the Bearer token and unwraps {code,data,msg}", async () => {
		const http = new MockHttp().enqueueEnvelope({
			id: 1,
			username: "zink",
			avatar_url: null,
			has_mobile: true,
			is_tourist: false,
			logged: true,
			onboarded: true
		});
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const profile = await client.getProfile();

		expect(profile.username).toBe("zink");
		expect(http.requests).toHaveLength(1);
		expect(http.requests[0].url).toBe(`${BASE_URL}/api/v1/users/profile`);
		expect(http.requests[0].method).toBe("GET");
		expect(http.requests[0].headers?.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("strips trailing slashes from baseUrl", async () => {
		const http = new MockHttp().enqueueEnvelope({ id: 1, username: "a" });
		const client = new PuzleClient(`${BASE_URL}/`, TOKEN, http);

		await client.getProfile();

		expect(http.requests[0].url).toBe(`${BASE_URL}/api/v1/users/profile`);
	});

	// 生产环境 (read-web.puzle.com.cn) 的成功码是 200，测试环境/文档写的是 0，两者都要认
	it.each([0, 200])("treats envelope code %d as success", async (code) => {
		const http = new MockHttp().enqueueEnvelope({ id: 2, username: "卢书洋" }, code, "success");
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await expect(client.getProfile()).resolves.toMatchObject({ id: 2, username: "卢书洋" });
	});

	it("unwraps a real production envelope shape", async () => {
		// 生产真实响应：{code:200, msg:'success', data:{...}, timestamp}
		const body = {
			code: 200,
			msg: "success",
			data: { total: 190, items: [{ id: 2860 }], page: 1, pageSize: 50 },
			timestamp: 1787035468
		};
		const http = new MockHttp().enqueue(() => ({
			status: 200,
			text: JSON.stringify(body),
			json: body
		}));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const page = await client.listReadingItems({ page: 1, page_size: 50 });
		expect(page.total).toBe(190);
		expect(page.items).toHaveLength(1);
	});

	it("throws ApiError with msg and code when code is not a success code", async () => {
		const http = new MockHttp().enqueueEnvelope(null, 404001, "user not found");
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await expect(client.getProfile()).rejects.toMatchObject({
			name: "ApiError",
			code: 404001,
			message: "user not found"
		});
	});

	it("throws AuthError on HTTP 401", async () => {
		const http = new MockHttp().enqueue(() => ({ status: 401, text: "", json: null }));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await expect(client.getProfile()).rejects.toBeInstanceOf(AuthError);
		await expect(
			(async () => {
				const http2 = new MockHttp().enqueue(() => ({ status: 401, text: "", json: null }));
				await new PuzleClient(BASE_URL, TOKEN, http2).getProfile();
			})()
		).rejects.toBeInstanceOf(ApiError);
	});

	it.each([401, 401001])("throws AuthError on envelope code %d", async (code) => {
		const http = new MockHttp().enqueueEnvelope(null, code, "token expired");
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await expect(client.getProfile()).rejects.toMatchObject({
			name: "AuthError",
			code,
			message: "token expired"
		});
	});

	it("throws ApiError on non-envelope HTTP error status", async () => {
		const http = new MockHttp().enqueue(() => ({ status: 500, text: "boom", json: null }));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await expect(client.getProfile()).rejects.toMatchObject({
			name: "ApiError",
			code: 500
		});
	});
});

describe("listReadingItems & iterateAllReadingItems", () => {
	it("passes pagination query params", async () => {
		const http = new MockHttp().enqueueEnvelope({ items: [], total: 0, page: 2, page_size: 10 });
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await client.listReadingItems({ page: 2, page_size: 10, search: "阅读", topics: [1, 2] });

		const params = new URL(http.requests[0].url).searchParams;
		expect(http.requests[0].url.startsWith(`${BASE_URL}/api/v1/reading/items`)).toBe(true);
		expect(params.get("page")).toBe("2");
		expect(params.get("page_size")).toBe("10");
		expect(params.get("search")).toBe("阅读");
		expect(params.get("topics")).toBe("1,2");
	});

	it("iterates all pages and stops when total is reached", async () => {
		const http = new MockHttp()
			.enqueueEnvelope(makeItemsPage(1, 50, 80))
			.enqueueEnvelope(makeItemsPage(2, 30, 80));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const items: ReadingItem[] = [];
		for await (const item of client.iterateAllReadingItems()) items.push(item);

		expect(items).toHaveLength(80);
		expect(http.requests).toHaveLength(2);
		expect(items[0].id).toBe(1);
		expect(items[79].id).toBe(80);
	});

	it("stops on a short page even when total is unreliable", async () => {
		const http = new MockHttp()
			.enqueueEnvelope(makeItemsPage(1, 50, 100000))
			.enqueueEnvelope(makeItemsPage(2, 20, 100000));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const items: ReadingItem[] = [];
		for await (const item of client.iterateAllReadingItems()) items.push(item);

		expect(items).toHaveLength(70);
		expect(http.requests).toHaveLength(2);
	});

	it("stops immediately on an empty first page", async () => {
		const http = new MockHttp().enqueueEnvelope({ items: [], total: 0, page: 1, page_size: 50 });
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const items: ReadingItem[] = [];
		for await (const item of client.iterateAllReadingItems()) items.push(item);

		expect(items).toHaveLength(0);
		expect(http.requests).toHaveLength(1);
	});

	it("never yields beyond the hard cap of 10000 items", async () => {
		const http = new MockHttp().setFallback((opts) =>
			envelope(makeItemsPage(pageParam(opts.url), ITERATE_PAGE_SIZE, 999999))
		);
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const items: ReadingItem[] = [];
		for await (const item of client.iterateAllReadingItems()) items.push(item);

		expect(items).toHaveLength(MAX_ITERATED_ITEMS);
		expect(http.requests).toHaveLength(MAX_ITERATED_ITEMS / ITERATE_PAGE_SIZE);
	});
});

describe("listHighlightsByReading / listCommentsByReading", () => {
	it("fetches all highlight pages for a reading_id", async () => {
		const makeHighlightPage = (page: number, count: number) => ({
			items: Array.from({ length: count }, (_, i) => ({
				id: (page - 1) * ITERATE_PAGE_SIZE + i + 1,
				highlight_type: "text",
				role: "user",
				category: "key_points",
				content: "高亮文本",
				created_at: "2026-03-18T15:02:11Z",
				location_data: { start_index: 0, end_index: 4 }
			})),
			total: 120,
			page,
			pageSize: ITERATE_PAGE_SIZE
		});
		const http = new MockHttp()
			.enqueueEnvelope(makeHighlightPage(1, 50))
			.enqueueEnvelope(makeHighlightPage(2, 50))
			.enqueueEnvelope(makeHighlightPage(3, 20));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const highlights = await client.listHighlightsByReading(123);

		expect(highlights).toHaveLength(120);
		expect(http.requests).toHaveLength(3);
		for (const req of http.requests) {
			expect(req.url.startsWith(`${BASE_URL}/api/v1/reading/highlights`)).toBe(true);
			expect(new URL(req.url).searchParams.get("reading_id")).toBe("123");
		}
	});

	it("fetches all comment pages for a reading_id", async () => {
		const makeCommentPage = (page: number, count: number) => ({
			items: Array.from({ length: count }, (_, i) => ({
				id: (page - 1) * ITERATE_PAGE_SIZE + i + 1,
				content: "评论",
				created_at: "2026-03-18T15:02:11Z",
				highlight_id: null
			})),
			total: 60,
			page,
			page_size: ITERATE_PAGE_SIZE
		});
		const http = new MockHttp()
			.enqueueEnvelope(makeCommentPage(1, 50))
			.enqueueEnvelope(makeCommentPage(2, 10));
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const comments = await client.listCommentsByReading(123);

		expect(comments).toHaveLength(60);
		expect(http.requests).toHaveLength(2);
		for (const req of http.requests) {
			expect(req.url.startsWith(`${BASE_URL}/api/v1/reading/comments`)).toBe(true);
			expect(new URL(req.url).searchParams.get("reading_id")).toBe("123");
		}
	});
});

describe("other endpoints", () => {
	it("getLinkDetail / getFileDetail / getSummary hit the right paths", async () => {
		const http = new MockHttp()
			.enqueueEnvelope({ ...makeReadingItem(1), content: "# body" })
			.enqueueEnvelope({
				...makeReadingItem(2),
				file_name: "a.pdf",
				human_media_type: "pdf",
				content: "body",
				download_link: null
			})
			.enqueueEnvelope({ key_points: ["k1"] });
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const link = await client.getLinkDetail(1);
		const file = await client.getFileDetail(2);
		const summary = await client.getSummary(1);

		expect(link.content).toBe("# body");
		expect(file.file_name).toBe("a.pdf");
		expect(summary.key_points).toEqual(["k1"]);
		expect(http.requests.map((r) => r.url)).toEqual([
			`${BASE_URL}/api/v1/reading/link/1`,
			`${BASE_URL}/api/v1/reading/file/2`,
			`${BASE_URL}/api/v1/reading/link/1/summary`
		]);
	});

	it("listTopics returns TopicItem[]", async () => {
		const http = new MockHttp().enqueueEnvelope([
			{ id: 1, parent_id: null, title: "阅读方法", note_count: 2, reading_count: 5 }
		]);
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		const topics = await client.listTopics();

		expect(topics).toHaveLength(1);
		expect(topics[0].title).toBe("阅读方法");
		expect(http.requests[0].url).toBe(`${BASE_URL}/api/v1/topics`);
	});

	it("deleteChat sends DELETE /api/v1/chat/{chat_id}", async () => {
		const http = new MockHttp().enqueueEnvelope(null);
		const client = new PuzleClient(BASE_URL, TOKEN, http);

		await client.deleteChat(214);

		expect(http.requests[0].method).toBe("DELETE");
		expect(http.requests[0].url).toBe(`${BASE_URL}/api/v1/chat/214`);
	});
});
