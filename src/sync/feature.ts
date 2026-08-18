import { Notice } from "obsidian";
import type { Plugin } from "obsidian";
import type { PluginDeps } from "../deps";
import { VaultGateway } from "../vault/gateway";
import { scaffoldWorkspace } from "../vault/scaffold";
import { ArticleSyncer } from "./article-syncer";
import { ChatSyncer } from "./chat-syncer";
import { SyncEngine, errorMessage } from "./engine";
import { HighlightSyncer } from "./highlight-syncer";
import { SyncStore } from "./store";

export function registerSyncFeature(plugin: Plugin, deps: PluginDeps): void {
	const store = new SyncStore({ getData: deps.getData, saveData: deps.saveData });
	const makeGateway = (): VaultGateway =>
		new VaultGateway(plugin.app, deps.getSettings().rootFolder);

	const engine = new SyncEngine({
		getClient: deps.getClient,
		getGateway: makeGateway,
		getSettings: deps.getSettings,
		store,
		notice: (message) => {
			new Notice(message);
		},
		logger: deps.logger
	});
	engine.register(new ArticleSyncer());
	engine.register(new HighlightSyncer());
	engine.register(new ChatSyncer(() => deps.getSocket()));

	const watcherGateway = makeGateway();
	plugin.registerEvent(
		watcherGateway.registerRenameWatcher((oldPath, newPath) => {
			if (store.handleRename(oldPath, newPath)) void store.flush();
		})
	);

	plugin.addCommand({
		id: "puzle-full-sync",
		name: "全量同步",
		callback: () => {
			void engine.runSync("full");
		}
	});
	plugin.addCommand({
		id: "puzle-incremental-sync",
		name: "增量同步",
		callback: () => {
			void engine.runSync("incremental");
		}
	});
	plugin.addCommand({
		id: "puzle-init-workspace",
		name: "初始化工作区",
		callback: () => {
			void (async () => {
				try {
					const report = await scaffoldWorkspace(makeGateway());
					new Notice(
						`Puzle Read：工作区初始化完成（新建 ${report.createdFolders.length} 个文件夹、${report.createdFiles.length} 个文件）`
					);
				} catch (error) {
					new Notice(`Puzle Read：工作区初始化失败 — ${errorMessage(error)}`);
				}
			})();
		}
	});

	// 每分钟读取一次设置判断是否到期，autoSyncMinutes 的修改即时生效，无需重启
	let lastAutoSyncAt = Date.now();
	plugin.registerInterval(
		window.setInterval(() => {
			const minutes = deps.getSettings().autoSyncMinutes;
			if (minutes <= 0) return;
			if (Date.now() - lastAutoSyncAt < minutes * 60 * 1000) return;
			lastAutoSyncAt = Date.now();
			void engine.runSync("incremental");
		}, 60 * 1000)
	);
}
