import type {
	CommentItem,
	FileReadingDetail,
	HighlightItem,
	LinkReadingDetail,
	PageResponse,
	ReadingItem,
	ReadingSummary,
	TopicItem,
	UserProfile
} from "../models";
import type { HttpMethod, HttpPort, HttpResponse } from "../ports";

export class ApiError extends Error {
	readonly code: number;
	readonly status: number | null;

	constructor(message: string, code: number, status: number | null = null) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
	}
}

export class AuthError extends ApiError {
	constructor(message = "Unauthorized", code = 401, status: number | null = null) {
		super(message, code, status);
		this.name = "AuthError";
	}
}

interface ApiEnvelope<T> {
	code: number;
	data: T;
	msg?: string | null;
}

export type QueryValue = string | number | boolean | Array<string | number> | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface ListReadingItemsParams {
	page?: number;
	page_size?: number;
	search?: string;
	topics?: Array<string | number> | string | number;
}

export const ITERATE_PAGE_SIZE = 50;
export const MAX_ITERATED_ITEMS = 10000;

/**
 * 业务成功码：生产环境返回 200，另有环境/文档使用 0，两者都接受。
 * 判错依据是「不在成功集合里」，而不是「不等于 0」。
 */
export const SUCCESS_CODES = new Set([0, 200]);
export const AUTH_ERROR_CODES = new Set([401, 401001, 40100, 4010]);

export class PuzleClient {
	private readonly baseUrl: string;
	private token: string;
	private readonly http: HttpPort;

	constructor(baseUrl: string, token: string, http: HttpPort) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.token = token;
		this.http = http;
	}

	setToken(token: string): void {
		this.token = token;
	}

	listReadingItems(params: ListReadingItemsParams = {}): Promise<PageResponse<ReadingItem>> {
		return this.request<PageResponse<ReadingItem>>("GET", "/api/v1/reading/items", {
			query: {
				page: params.page,
				page_size: params.page_size,
				search: params.search,
				topics: params.topics
			}
		});
	}

	async *iterateAllReadingItems(
		filter: Omit<ListReadingItemsParams, "page" | "page_size"> = {}
	): AsyncGenerator<ReadingItem, void, unknown> {
		let page = 1;
		let yielded = 0;
		for (;;) {
			const res = await this.listReadingItems({
				...filter,
				page,
				page_size: ITERATE_PAGE_SIZE
			});
			const items = res.items ?? [];
			for (const item of items) {
				if (yielded >= MAX_ITERATED_ITEMS) return;
				yield item;
				yielded += 1;
			}
			if (items.length === 0) return;
			if (yielded >= MAX_ITERATED_ITEMS) return;
			if (typeof res.total === "number" && yielded >= res.total) return;
			if (items.length < ITERATE_PAGE_SIZE) return;
			page += 1;
		}
	}

	getLinkDetail(readingId: number): Promise<LinkReadingDetail> {
		return this.request<LinkReadingDetail>("GET", `/api/v1/reading/link/${readingId}`);
	}

	getFileDetail(readingId: number): Promise<FileReadingDetail> {
		return this.request<FileReadingDetail>("GET", `/api/v1/reading/file/${readingId}`);
	}

	getSummary(readingId: number): Promise<ReadingSummary> {
		return this.request<ReadingSummary>("GET", `/api/v1/reading/link/${readingId}/summary`);
	}

	listHighlightsByReading(readingId: number, pageSize = ITERATE_PAGE_SIZE): Promise<HighlightItem[]> {
		return this.collectAll<HighlightItem>(
			(page) =>
				this.request<PageResponse<HighlightItem>>("GET", "/api/v1/reading/highlights", {
					query: { reading_id: readingId, page, page_size: pageSize }
				}),
			pageSize
		);
	}

	listCommentsByReading(readingId: number, pageSize = ITERATE_PAGE_SIZE): Promise<CommentItem[]> {
		return this.collectAll<CommentItem>(
			(page) =>
				this.request<PageResponse<CommentItem>>("GET", "/api/v1/reading/comments", {
					query: { reading_id: readingId, page, page_size: pageSize }
				}),
			pageSize
		);
	}

	getProfile(): Promise<UserProfile> {
		return this.request<UserProfile>("GET", "/api/v1/users/profile");
	}

	listTopics(): Promise<TopicItem[]> {
		return this.request<TopicItem[]>("GET", "/api/v1/topics");
	}

	deleteChat(chatId: number): Promise<unknown> {
		return this.request<unknown>("DELETE", `/api/v1/chat/${chatId}`);
	}

	private async collectAll<T>(
		fetchPage: (page: number) => Promise<PageResponse<T>>,
		pageSize: number
	): Promise<T[]> {
		const collected: T[] = [];
		let page = 1;
		for (;;) {
			const res = await fetchPage(page);
			const items = res.items ?? [];
			for (const item of items) {
				if (collected.length >= MAX_ITERATED_ITEMS) return collected;
				collected.push(item);
			}
			if (items.length === 0) return collected;
			if (typeof res.total === "number" && collected.length >= res.total) return collected;
			if (items.length < pageSize) return collected;
			page += 1;
		}
	}

	private buildUrl(path: string, query?: QueryParams): string {
		const url = `${this.baseUrl}${path}`;
		if (!query) return url;
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null || value === "") continue;
			if (Array.isArray(value)) {
				if (value.length > 0) params.set(key, value.join(","));
				continue;
			}
			params.set(key, String(value));
		}
		const qs = params.toString();
		return qs ? `${url}?${qs}` : url;
	}

	private async request<T>(
		method: HttpMethod,
		path: string,
		opts: { query?: QueryParams; body?: unknown } = {}
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${this.token}`
		};
		let body: string | undefined;
		if (opts.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		const response = await this.http.request({
			url: this.buildUrl(path, opts.query),
			method,
			headers,
			body
		});
		return this.unwrap<T>(response);
	}

	private unwrap<T>(response: HttpResponse): T {
		if (response.status === 401) {
			throw new AuthError("HTTP 401 Unauthorized", 401, response.status);
		}
		const envelope = response.json as Partial<ApiEnvelope<T>> | null;
		if (envelope && typeof envelope === "object" && typeof envelope.code === "number") {
			if (SUCCESS_CODES.has(envelope.code)) return envelope.data as T;
			const msg = envelope.msg ?? `API error code ${envelope.code}`;
			if (AUTH_ERROR_CODES.has(envelope.code)) {
				throw new AuthError(msg, envelope.code, response.status);
			}
			throw new ApiError(msg, envelope.code, response.status);
		}
		if (response.status >= 400) {
			throw new ApiError(`HTTP ${response.status}`, response.status, response.status);
		}
		return response.json as T;
	}
}
