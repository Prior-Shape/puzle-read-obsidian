import { Notice, Plugin } from "obsidian";
import { NativeSocketFactory, NoticeLogger, ObsidianHttpPort } from "./adapters/obsidian";
import { registerChatFeature } from "./chat/feature";
import { PuzleClient } from "./core/api/client";
import type { Logger } from "./core/ports";
import { PuzleSocket } from "./core/ws/manager";
import type { PluginDeps } from "./deps";
import { PuzleSettingTab, mergePluginData } from "./settings";
import type { PluginData } from "./settings";
import { registerSyncFeature } from "./sync/feature";
import { registerWriterFeature } from "./writer/feature";

export function deriveWsUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
	const wsBase = withScheme.replace(/^http/, "ws");
	return `${wsBase}/api/v1/agent/events`;
}

export default class PuzleReadPlugin extends Plugin {
	data!: PluginData;

	private readonly logger: Logger = new NoticeLogger();
	private readonly httpPort = new ObsidianHttpPort();
	private readonly socketFactory = new NativeSocketFactory();
	private client!: PuzleClient;
	private socket: PuzleSocket | null = null;
	private clientKey = "";

	async onload(): Promise<void> {
		this.data = mergePluginData(await this.loadData());
		this.rebuildClient();

		this.addSettingTab(new PuzleSettingTab(this.app, this));

		const deps: PluginDeps = {
			logger: this.logger,
			getSettings: () => this.data.settings,
			getData: () => this.data,
			getClient: () => this.client,
			getSocket: () => this.getSocket(),
			saveData: () => this.saveSettings()
		};
		registerSyncFeature(this, deps);
		registerChatFeature(this, deps);
		registerWriterFeature(this, deps);

		this.app.workspace.onLayoutReady(() => {
			if (!this.data.settings.token) {
				new Notice("Puzle Read：尚未配置 Token，请到「设置 → Puzle Read」粘贴 Token 并测试连接", 8000);
			}
		});
	}

	onunload(): void {
		this.socket?.disconnect();
		this.socket = null;
	}

	getSocket(): PuzleSocket {
		if (!this.socket) {
			this.socket = new PuzleSocket(
				() => deriveWsUrl(this.data.settings.baseUrl),
				() => this.data.settings.token,
				this.socketFactory,
				{ logger: this.logger }
			);
		}
		return this.socket;
	}

	async saveSettings(): Promise<void> {
		this.rebuildClient();
		await this.saveData(this.data);
	}

	private rebuildClient(): void {
		const { baseUrl, token } = this.data.settings;
		const key = `${baseUrl}\u0000${token}`;
		if (this.client && key === this.clientKey) return;
		this.clientKey = key;
		this.client = new PuzleClient(baseUrl, token, this.httpPort);
		// The socket instance lives for the whole plugin lifetime; refresh tears
		// down the connection so the URL/token providers are re-read on reconnect.
		this.socket?.refresh();
	}
}
