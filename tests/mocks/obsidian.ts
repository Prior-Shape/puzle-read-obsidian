import { parse, stringify } from "yaml";

export function parseYaml<T = unknown>(source: string): T {
	return parse(source) as T;
}

export function stringifyYaml(value: unknown): string {
	return stringify(value);
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

export class App {}

export class Plugin {}

export class Component {
	private children: Component[] = [];

	load(): void {
		for (const child of this.children) child.load();
	}

	unload(): void {
		for (const child of this.children) child.unload();
	}

	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		return child;
	}
}

export class MarkdownRenderChild extends Component {
	containerEl: unknown;

	constructor(containerEl: unknown) {
		super();
		this.containerEl = containerEl;
	}
}

export class MarkdownRenderer extends MarkdownRenderChild {
	static render(
		app: unknown,
		markdown: string,
		el: { textContent?: string | null },
		sourcePath: string,
		component: Component
	): Promise<void> {
		void app;
		void sourcePath;
		void component;
		el.textContent = markdown;
		return Promise.resolve();
	}

	static renderMarkdown(
		markdown: string,
		el: { textContent?: string | null },
		sourcePath: string,
		component: Component
	): Promise<void> {
		void sourcePath;
		void component;
		el.textContent = markdown;
		return Promise.resolve();
	}
}

export class Workspace {}

export class WorkspaceLeaf {}

export class View extends Component {
	app: unknown;
	leaf: unknown;
	containerEl: unknown = null;

	constructor(leaf: unknown) {
		super();
		this.leaf = leaf;
	}
}

export class ItemView extends View {
	contentEl: unknown = null;

	getViewType(): string {
		return "";
	}

	getDisplayText(): string {
		return "";
	}

	getIcon(): string {
		return "";
	}

	async onOpen(): Promise<void> {}

	async onClose(): Promise<void> {}
}

export class Notice {
	constructor(
		public readonly message?: unknown,
		public readonly timeout?: number
	) {}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: unknown = null;

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {}

	hide(): void {}
}

export class Setting {
	constructor(containerEl: unknown) {
		void containerEl;
	}

	setName(name: string): this {
		void name;
		return this;
	}

	setDesc(desc: string): this {
		void desc;
		return this;
	}

	setHeading(): this {
		return this;
	}

	addText(cb: (text: unknown) => unknown): this {
		void cb;
		return this;
	}

	addTextArea(cb: (area: unknown) => unknown): this {
		void cb;
		return this;
	}

	addToggle(cb: (toggle: unknown) => unknown): this {
		void cb;
		return this;
	}

	addDropdown(cb: (dropdown: unknown) => unknown): this {
		void cb;
		return this;
	}

	addButton(cb: (button: unknown) => unknown): this {
		void cb;
		return this;
	}
}

export function requestUrl(req: unknown): Promise<never> {
	void req;
	return Promise.reject(new Error("requestUrl is not available in tests"));
}

export class TAbstractFile {
	path: string = "";
	name: string = "";
}

export class TFile extends TAbstractFile {
	extension: string = "md";
	basename: string = "";
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}
