import { AbstractInputSuggest, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type { App, ButtonComponent } from "obsidian";
import { ObsidianHttpPort } from "./adapters/obsidian";
import { calibrate, formatScores } from "./annotations/calibrate";
import { PLAINTEXT_VARIANTS } from "./annotations/plaintext";
import type { PlaintextVariant } from "./annotations/plaintext";
import { ArticleSourceCache } from "./annotations/source";
import { AuthError, PuzleClient } from "./core/api/client";
import type PuzleReadPlugin from "./main";

export type OnEditedManaged = "overwrite" | "skip";

export interface Settings {
	baseUrl: string;
	token: string;
	rootFolder: string;
	autoSyncMinutes: number;
	injectAnchors: boolean;
	readingMode: boolean;
	keepThinking: boolean;
	onEditedManaged: OnEditedManaged;
	/** 计算高亮偏移时使用的纯文本口径，可用「自动校准」按已有高亮反推 */
	plaintextVariant: PlaintextVariant;
}

export const DEFAULT_SETTINGS: Settings = {
	baseUrl: "https://read-web.puzle.com.cn",
	token: "",
	rootFolder: "PuzleRead",
	autoSyncMinutes: 0,
	injectAnchors: true,
	readingMode: true,
	keepThinking: false,
	onEditedManaged: "overwrite",
	plaintextVariant: "raw"
};

export interface SyncArticleState {
	path: string;
	fingerprint: string;
	managedHash: string;
	syncedAt: string;
	/** 该文章绑定的会话；一篇文章只有一个，插件内新建会话后回填 */
	chatId?: number | null;
	/** link / file —— 「刷新这一篇」时决定调哪个详情接口，老数据缺这个字段时会现探测 */
	resourceType?: "link" | "file";
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
	/** 历史遗留：曾经的 AI 续写专用会话。功能已下线，字段保留只为继续把它挡在会话列表与同步之外 */
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

/** 归一化根目录：去掉首尾斜杠与空白，防止写出 `/PuzleRead/` 这种路径。 */
export function normalizeRootFolder(value: string): string {
	return value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

const SAVE_DEBOUNCE_MS = 500;

/** 给「根目录」输入框加上 Vault 内已有文件夹的自动补全，省得手打路径。 */
class FolderSuggest extends AbstractInputSuggest<string> {
	private readonly onPick: (value: string) => void;

	constructor(app: App, inputEl: HTMLInputElement, onPick: (value: string) => void) {
		super(app, inputEl);
		this.onPick = onPick;
	}

	protected getSuggestions(query: string): string[] {
		const needle = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder && file.path !== "/")
			.map((folder) => folder.path)
			.filter((path) => path.toLowerCase().includes(needle))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 50);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		this.onPick(value);
		this.close();
	}
}

export class PuzleSettingTab extends PluginSettingTab {
	private readonly plugin: PuzleReadPlugin;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, plugin: PuzleReadPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		this.flushPendingSave();
		super.hide();
	}

	// 输入框每个键击都会触发 onChange；防抖避免每键写盘、重建 client/socket
	private queueSave(): void {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}, SAVE_DEBOUNCE_MS);
	}

	private flushPendingSave(): void {
		if (this.saveTimer === null) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
		void this.plugin.saveSettings();
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
					.onChange((value: string) => {
						settings.baseUrl = value.trim();
						this.queueSave();
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
					.onChange((value: string) => {
						settings.token = value.trim();
						this.queueSave();
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
					.onChange((value: string) => {
						settings.rootFolder = normalizeRootFolder(value) || DEFAULT_SETTINGS.rootFolder;
						this.queueSave();
					});
				new FolderSuggest(this.app, text.inputEl, (picked: string) => {
					settings.rootFolder = normalizeRootFolder(picked) || DEFAULT_SETTINGS.rootFolder;
					this.queueSave();
				});
			});

		new Setting(containerEl)
			.setName("自动同步间隔（分钟）")
			.setDesc("0 = 关闭自动同步")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.autoSyncMinutes)).onChange((value: string) => {
					const parsed = Number.parseInt(value, 10);
					settings.autoSyncMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
					this.queueSave();
				});
			});

		new Setting(containerEl)
			.setName("注入高亮锚点")
			.setDesc("同步文章时在正文中插入 ==高亮== 标记与 💬 角标")
			.addToggle((toggle) => {
				toggle.setValue(settings.injectAnchors).onChange((value: boolean) => {
					settings.injectAnchors = value;
					this.queueSave();
				});
			});

		new Setting(containerEl)
			.setName("以阅读模式打开同步内容")
			.setDesc(
				"打开根目录下的同步笔记时自动切换到阅读视图，避免误改正文。仍可用 Cmd/Ctrl+E 手动切回编辑"
			)
			.addToggle((toggle) => {
				toggle.setValue(settings.readingMode).onChange((value: boolean) => {
					settings.readingMode = value;
					this.queueSave();
				});
			});

		new Setting(containerEl)
			.setName("保留思考过程")
			.setDesc("同步对话时把思考/工具日志渲染为折叠块")
			.addToggle((toggle) => {
				toggle.setValue(settings.keepThinking).onChange((value: boolean) => {
					settings.keepThinking = value;
					this.queueSave();
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
					.onChange((value: string) => {
						settings.onEditedManaged = value as OnEditedManaged;
						this.queueSave();
					});
			});

		new Setting(containerEl)
			.setName("高亮定位口径")
			.setDesc(
				"创建高亮时把正文选区换算成后端偏移所用的纯文本口径。点「自动校准」会拿账号里已有的高亮当标准答案反推，选出对得上的那个"
			)
			.addDropdown((dropdown) => {
				for (const variant of PLAINTEXT_VARIANTS) dropdown.addOption(variant, variant);
				dropdown.setValue(settings.plaintextVariant).onChange((value: string) => {
					settings.plaintextVariant = value as PlaintextVariant;
					this.queueSave();
				});
			})
			.addButton((button) => {
				button.setButtonText("自动校准").onClick(() => {
					void this.calibrateVariant(button);
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

	private async calibrateVariant(button: ButtonComponent): Promise<void> {
		this.flushPendingSave();
		const { baseUrl, token } = this.plugin.data.settings;
		if (!token) {
			new Notice("请先填写 Token");
			return;
		}
		button.setDisabled(true);
		button.setButtonText("校准中…");
		try {
			const client = new PuzleClient(baseUrl, token, new ObsidianHttpPort());
			const cache = new ArticleSourceCache(this.plugin, () => client);
			const result = await calibrate(client, cache, {
				maxArticles: 5,
				onProgress: (done, target) => button.setButtonText(`校准中 ${done}/${target}…`)
			});
			console.info("[Puzle Read] 高亮定位口径校准", result.scores);
			if (!result.best || result.best.total === 0) {
				new Notice(`Puzle Read：${formatScores(result)}`, 10000);
				return;
			}
			this.plugin.data.settings.plaintextVariant = result.best.variant;
			await this.plugin.saveSettings();
			this.display();
			const rate = Math.round((result.best.exact / result.best.total) * 100);
			new Notice(
				`Puzle Read：已选用「${result.best.variant}」口径，${result.best.exact}/${result.best.total}（${rate}%）条已有高亮能精确还原。\n${formatScores(result)}`,
				12000
			);
		} catch (error) {
			new Notice(`Puzle Read：校准失败 — ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			button.setDisabled(false);
			button.setButtonText("自动校准");
		}
	}

	private async testConnection(button: ButtonComponent): Promise<void> {
		this.flushPendingSave();
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
