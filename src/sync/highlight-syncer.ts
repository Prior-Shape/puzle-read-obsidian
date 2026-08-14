import { hashManaged } from "../vault/managed";
import {
	createReport,
	errorMessage,
	highlightBaseName,
	storedRelativePath,
	type SyncContext,
	type SyncReport,
	type Syncer
} from "./engine";
import { highlightFrontmatter, renderHighlightManaged } from "./render/highlight";

export class HighlightSyncer implements Syncer {
	readonly key = "highlights";

	async sync(ctx: SyncContext): Promise<SyncReport> {
		const report = createReport(this.key);
		const { store, settings, shared, vaultGateway } = ctx;

		for (const job of shared.highlightJobs) {
			if (ctx.signal?.aborted) break;
			const id = job.highlight.id;
			const prev = store.getHighlight(id);
			const relative = storedRelativePath(
				vaultGateway,
				prev?.path,
				`Highlights/${highlightBaseName(job)}.md`
			);

			try {
				if (prev && settings.onEditedManaged === "skip") {
					const current = await vaultGateway.readManagedHash(relative);
					if (current !== null && prev.managedHash && current !== prev.managedHash) {
						ctx.notice(`Puzle Read：高亮 h${id} 的 managed 区有本地修改，已跳过`);
						report.skipped += 1;
						continue;
					}
				}

				const managed = renderHighlightManaged({
					highlight: job.highlight,
					comments: job.comments
				});
				const file = await vaultGateway.writeManaged(
					relative,
					highlightFrontmatter(job.highlight, job.readingId, job.articleBaseName),
					managed
				);
				const managedHash =
					(await vaultGateway.readManagedHash(relative)) ?? hashManaged(managed);
				store.setHighlight(id, {
					path: file.path,
					managedHash,
					readingId: job.readingId
				});
				report[prev ? "updated" : "created"] += 1;
			} catch (error) {
				report.failed += 1;
				ctx.notice(`Puzle Read：高亮 h${id} 写入失败：${errorMessage(error)}`);
			}
		}

		for (const [id, state] of store.highlightEntries()) {
			if (ctx.signal?.aborted) break;
			if (state.readingId === undefined) continue;
			const remoteIds = shared.remoteHighlightIds.get(state.readingId);
			if (!remoteIds || remoteIds.has(id)) continue;

			const file = vaultGateway.app.vault.getFileByPath(state.path);
			if (file) {
				try {
					await vaultGateway.app.fileManager.trashFile(file);
				} catch (error) {
					report.failed += 1;
					ctx.notice(`Puzle Read：高亮 h${id} 移入回收站失败：${errorMessage(error)}`);
					continue;
				}
			}
			store.deleteHighlight(id);
			report.deleted += 1;
		}

		await store.flush();
		return report;
	}
}
