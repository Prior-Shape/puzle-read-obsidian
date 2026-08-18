import { Notice, PluginSettingTab, Setting } from "obsidian";
import type { App, ButtonComponent } from "obsidian";
import { ObsidianHttpPort } from "./adapters/obsidian";
import { AuthError, PuzleClient } from "./core/api/client";
import type PuzleReadPlugin from "./main";

export type OnEditedManaged = "overwrite" | "skip";

export interface Settings {
	baseUrl: string;
	token: string;
	rootFolder: string;
	autoSyncMinutes: number;
	injectAnchors: boolean;
	keepThinking: boolean;
	onEditedManaged: OnEditedManaged;
	continueMaxChars: number;
}

export const DEFAULT_SETTINGS: Settings = {
	baseUrl: "https://read-web-test.puzle.com.cn",
	token: "",
	rootFolder: "PuzleRead",
	autoSyncMinutes: 0,
	injectAnchors: true,
	keepThinking: false,
	onEditedManaged: "overwrite",
	continueMaxChars: 4000
};

export interface SyncArticleState {
	path: string;
	fingerprint: string;
	managedHash: string;
	syncedAt: string;
}

export interface SyncHighlightState {
	path: string;
	managedHash: string;
	readingId?: number;
}

export interface SyncChatState {
	path: string;
	turnCount: number;
	managedHash: string;
}

export interface SyncState {
	lastSyncAt: string | null;
	articles: Record<number, SyncArticleState>;
	highlights: Record<number, SyncHighlightState>;
	chats: Record<number, SyncChatState>;
	continuationChatId: number | null;
}

export const DEFAULT_SYNC_STATE: SyncState = {
	lastSyncAt: null,
	articles: {},
	highlights: {},
	chats: {},
	continuationChatId: null
};

export interface PluginData {
	settings: Settings;
	syncState: SyncState;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(base)) {
		return patch === undefined ? base : (patch as T);
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	if (isPlainObject(patch)) {
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			const baseValue = out[key];
			out[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
		}
	}
	return out as T;
}

export function cloneDefaultPluginData(): PluginData {
	return {
		settings: { ...DEFAULT_SETTINGS },
		syncState: {
			...DEFAULT_SYNC_STATE,
			articles: {},
			highlights: {},
			chats: {}
		}
	};
}

export function mergePluginData(saved: unknown): PluginData {
	return deepMerge(cloneDefaultPluginData(), saved);
}

export class PuzleSettingTab extends PluginSettingTab {
	private readonly plugin: PuzleReadPlugin;

	constructor(app: App, plugin: PuzleReadPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.data.settings;

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("Puzle 后端服务地址")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.baseUrl)
					.setValue(settings.baseUrl)
					.onChange(async (value: string) => {
						settings.baseUrl = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Token")
			.setDesc(
				"Web 端登录后从浏览器 localStorage 的 puzle_auth_token 获取。注意：Token 以明文保存在本 Vault 的插件数据文件（data.json）中，请勿把该文件同步到不信任的位置"
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("粘贴 Token")
					.setValue(settings.token)
					.onChange(async (value: string) => {
						settings.token = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("根目录")
			.setDesc(
				"同步内容在 Vault 中的根文件夹。已有同步内容时请先在 Obsidian 里重命名原文件夹（插件会自动跟踪），再修改此处；直接修改会在新目录下重新同步一份，旧目录内容原样保留"
			)
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.rootFolder)
					.setValue(settings.rootFolder)
					.onChange(async (value: string) => {
						settings.rootFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("自动同步间隔（分钟）")
			.setDesc("0 = 关闭自动同步")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.autoSyncMinutes)).onChange(async (value: string) => {
					const parsed = Number.parseInt(value, 10);
					settings.autoSyncMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("注入高亮锚点")
			.setDesc("同步文章时在正文中插入 ==高亮== 标记与 💬 角标")
			.addToggle((toggle) => {
				toggle.setValue(settings.injectAnchors).onChange(async (value: boolean) => {
					settings.injectAnchors = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("保留思考过程")
			.setDesc("同步对话时把思考/工具日志渲染为折叠块")
			.addToggle((toggle) => {
				toggle.setValue(settings.keepThinking).onChange(async (value: boolean) => {
					settings.keepThinking = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("managed 区已被本地编辑时")
			.setDesc("再次同步写入 managed 区的策略")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("overwrite", "覆盖")
					.addOption("skip", "跳过")
					.setValue(settings.onEditedManaged)
					.onChange(async (value: string) => {
						settings.onEditedManaged = value as OnEditedManaged;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("续写上下文最大字符数")
			.setDesc("AI 续写时取光标前文本的字符上限")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.continueMaxChars)).onChange(async (value: string) => {
					const parsed = Number.parseInt(value, 10);
					settings.continueMaxChars =
						Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.continueMaxChars;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("测试连接")
			.setDesc("调用 GET /api/v1/users/profile 校验 Token")
			.addButton((button) => {
				button
					.setButtonText("测试连接")
					.setCta()
					.onClick(() => {
						void this.testConnection(button);
					});
			});
	}

	private async testConnection(button: ButtonComponent): Promise<void> {
		const { baseUrl, token } = this.plugin.data.settings;
		button.setDisabled(true);
		button.setButtonText("测试中…");
		try {
			if (!token) {
				new Notice("请先填写 Token");
				return;
			}
			const client = new PuzleClient(baseUrl, token, new ObsidianHttpPort());
			const profile = await client.getProfile();
			new Notice(`连接成功：${profile.username}`);
			if (!this.plugin.data.syncState.lastSyncAt) {
				new Notice(
					"Puzle Read：连接正常。执行命令「Puzle Read: 全量同步」即可开始首次同步（会自动初始化工作区）",
					8000
				);
			}
		} catch (error) {
			if (error instanceof AuthError) {
				new Notice("Token 已失效，请重新粘贴");
			} else {
				new Notice(`连接失败：${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			button.setDisabled(false);
			button.setButtonText("测试连接");
		}
	}
}
