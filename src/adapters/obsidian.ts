import { Notice, requestUrl } from "obsidian";
import type {
	HttpPort,
	HttpRequestOptions,
	HttpResponse,
	Logger,
	SocketFactory,
	WebSocketLike
} from "../core/ports";

export class ObsidianHttpPort implements HttpPort {
	async request(opts: HttpRequestOptions): Promise<HttpResponse> {
		const response = await requestUrl({
			url: opts.url,
			method: opts.method ?? "GET",
			headers: opts.headers,
			body: opts.body,
			throw: false
		});
		let json: unknown = null;
		try {
			json = response.json;
		} catch {
			json = null;
		}
		return { status: response.status, json, text: response.text };
	}
}

export class NativeSocketFactory implements SocketFactory {
	create(url: string, protocols?: string | string[]): WebSocketLike {
		return new WebSocket(url, protocols) as unknown as WebSocketLike;
	}
}

export class NoticeLogger implements Logger {
	debug(...args: unknown[]): void {
		console.debug("[PuzleRead]", ...args);
	}

	info(...args: unknown[]): void {
		console.info("[PuzleRead]", ...args);
	}

	warn(...args: unknown[]): void {
		console.warn("[PuzleRead]", ...args);
	}

	error(...args: unknown[]): void {
		console.error("[PuzleRead]", ...args);
		const message = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
		if (message) new Notice(message);
	}
}
