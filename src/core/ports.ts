export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequestOptions {
	url: string;
	method?: HttpMethod;
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	json: unknown;
	text: string;
}

export interface HttpPort {
	request(opts: HttpRequestOptions): Promise<HttpResponse>;
}

export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev?: any) => void) | null;
	onmessage: ((ev: any) => void) | null;
	onerror: ((ev?: any) => void) | null;
	onclose: ((ev: any) => void) | null;
}

export interface SocketFactory {
	create(url: string, protocols?: string | string[]): WebSocketLike;
}

export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

export interface Clock {
	now(): number;
}
