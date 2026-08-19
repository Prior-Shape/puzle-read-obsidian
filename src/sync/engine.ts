import type { PuzleClient } from "../core/api/client";
import { AuthError } from "../core/api/client";
import type { CommentItem, HighlightItem } from "../core/models";
import type { Logger } from "../core/ports";
import type { Settings } from "../settings";
import { sanitizeFileName, type VaultGateway } from "../vault/gateway";
import { scaffoldWorkspace } from "../vault/scaffold";
import type { SyncStore } from "./store";

export type SyncMode = "full" | "incremental";

export interface SyncReport {
	key: string;
	created: number;
	updated: number;
	skipped: number;
	deleted: number;
	failed: number;
}

export function createReport(key: string): SyncReport {
	return { key, created: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 };
}

export interface HighlightJob {
	readingId: number;
	articleTitle: string;
	articleBaseName: string;
	highlight: HighlightItem;
	comments: CommentItem[];
}

export interface SyncSharedState {
	highlightJobs: HighlightJob[];
	remoteHighlightIds: Map<number, Set<number>>;
}

export function createSharedState(): SyncSharedState {
	return { highlightJobs: [], remoteHighlightIds: new Map() };
}

export interface SyncContext {
	mode: SyncMode;
	client: PuzleClient;
	vaultGateway: VaultGateway;
	store: SyncStore;
	settings: Settings;
	shared: SyncSharedState;
	now: string;
	notice(message: string): void;
	signal?: AbortSignal;
}

export interface Syncer {
	readonly key: string;
	sync(ctx: SyncContext): Promise<SyncReport>;
}

export function highlightBaseName(job: HighlightJob): string {
	return `${sanitizeFileName(job.articleTitle)} h${job.highlight.id}`;
}

export function storedRelativePath(
	gateway: VaultGateway,
	storedPath: string | undefined,
	fallback: string
): string {
	if (storedPath) {
		const rootPrefix = `${gateway.root}/`;
		if (storedPath.startsWith(rootPrefix)) return storedPath.slice(rootPrefix.length);
	}
	return fallback;
}

/** 同步/写回统一使用的时间戳口径：秒级 UTC，写进 frontmatter 的 `synced` */
export function syncTimestamp(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface SyncEngineOptions {
	getClient(): PuzleClient;
	getGateway(): VaultGateway;
	getSettings(): Settings;
	store: SyncStore;
	notice(message: string): void;
	logger?: Logger;
}

export class SyncEngine {
	private syncing = false;
	private readonly syncers: Syncer[] = [];

	constructor(private readonly options: SyncEngineOptions) {}

	get isSyncing(): boolean {
		return this.syncing;
	}

	register(syncer: Syncer): void {
		this.syncers.push(syncer);
	}

	async runSync(mode: SyncMode, signal?: AbortSignal): Promise<SyncReport[]> {
		if (this.syncing) {
			this.options.notice("Puzle Read：正在同步中，请稍候");
			return [];
		}
		this.syncing = true;
		const reports: SyncReport[] = [];
		const gateway = this.options.getGateway();
		const now = syncTimestamp();
		const ctx: SyncContext = {
			mode,
			client: this.options.getClient(),
			vaultGateway: gateway,
			store: this.options.store,
			settings: this.options.getSettings(),
			shared: createSharedState(),
			now,
			notice: (message) => this.options.notice(message),
			signal
		};
		try {
			await scaffoldWorkspace(gateway);
			this.options.notice(
				mode === "full" ? "Puzle Read：开始全量同步…" : "Puzle Read：开始增量同步…"
			);
			for (const syncer of this.syncers) {
				const report = await syncer.sync(ctx);
				reports.push(report);
				await ctx.store.flush();
			}
			ctx.store.setLastSyncAt(now);
			await ctx.store.flush();
			this.options.notice(summarizeReports(mode, reports));
		} catch (error) {
			if (error instanceof AuthError) {
				this.options.notice("Puzle Read：Token 已失效，请在设置中重新粘贴");
			} else {
				this.options.notice(`Puzle Read：同步失败 — ${errorMessage(error)}`);
			}
			this.options.logger?.error("sync failed", error);
			await ctx.store.flush().catch(() => undefined);
		} finally {
			this.syncing = false;
		}
		return reports;
	}
}

export function summarizeReports(mode: SyncMode, reports: SyncReport[]): string {
	const total = reports.reduce(
		(acc, report) => ({
			created: acc.created + report.created,
			updated: acc.updated + report.updated,
			skipped: acc.skipped + report.skipped,
			deleted: acc.deleted + report.deleted,
			failed: acc.failed + report.failed
		}),
		{ created: 0, updated: 0, skipped: 0, deleted: 0, failed: 0 }
	);
	const label = mode === "full" ? "全量同步" : "增量同步";
	const parts = [`${total.created} 新增`, `${total.updated} 更新`, `${total.skipped} 跳过`];
	if (total.deleted > 0) parts.push(`${total.deleted} 删除`);
	if (total.failed > 0) parts.push(`${total.failed} 失败`);
	return `Puzle Read：${label}完成，${parts.join("，")}`;
}
