import { normalizePath } from "obsidian";
import type { Plugin } from "obsidian";
import type { PuzleClient } from "../core/api/client";
import { htmlToPlainText } from "./plaintext";
import type { PlaintextVariant } from "./plaintext";

/**
 * 创建高亮要算「后端纯文本偏移」，而纯文本只能从正文 HTML 推出来，
 * 所以把 HTML 缓存到插件目录（不是 Vault，别污染用户笔记）。
 * 缓存 HTML 而不是纯文本：口径变了可以就地重算，不用再请求一次。
 */
export class ArticleSourceCache {
	private readonly memory = new Map<number, string>();

	constructor(
		private readonly plugin: Plugin,
		private readonly getClient: () => PuzleClient
	) {}

	async getHtml(readingId: number, force = false): Promise<string> {
		if (!force) {
			const cached = this.memory.get(readingId);
			if (cached !== undefined) return cached;
			const onDisk = await this.readFile(readingId);
			if (onDisk !== null) {
				this.memory.set(readingId, onDisk);
				return onDisk;
			}
		}
		const html = await this.fetchHtml(readingId);
		this.memory.set(readingId, html);
		await this.writeFile(readingId, html);
		return html;
	}

	async getPlainText(readingId: number, variant: PlaintextVariant): Promise<string> {
		return htmlToPlainText(await this.getHtml(readingId), variant);
	}

	async clear(): Promise<void> {
		this.memory.clear();
		const dir = this.dir();
		if (!dir) return;
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(dir))) return;
		const listing = await adapter.list(dir);
		for (const file of listing.files) await adapter.remove(file);
	}

	/** 条目可能是 link 也可能是 file，frontmatter 里没记类型，按顺序试。 */
	private async fetchHtml(readingId: number): Promise<string> {
		const client = this.getClient();
		try {
			const detail = await client.getLinkDetail(readingId);
			if (detail?.content) return detail.content;
		} catch {
			// 落到 file 详情
		}
		const detail = await client.getFileDetail(readingId);
		return detail?.content ?? "";
	}

	private dir(): string | null {
		const base = this.plugin.manifest.dir;
		return base ? normalizePath(`${base}/cache`) : null;
	}

	private path(readingId: number): string | null {
		const dir = this.dir();
		return dir ? `${dir}/article-${readingId}.html` : null;
	}

	private async readFile(readingId: number): Promise<string | null> {
		const path = this.path(readingId);
		if (!path) return null;
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (!(await adapter.exists(path))) return null;
			return await adapter.read(path);
		} catch {
			return null;
		}
	}

	private async writeFile(readingId: number, html: string): Promise<void> {
		const dir = this.dir();
		const path = this.path(readingId);
		if (!dir || !path) return;
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(path, html);
		} catch {
			// 缓存写失败不影响主流程，下次重新拉
		}
	}
}
