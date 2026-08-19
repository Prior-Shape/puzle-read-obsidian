import { MarkdownView, Menu } from "obsidian";
import type { Editor, Plugin, TFile } from "obsidian";
import { getSelectionContext } from "./selection";
import type { SelectionContext } from "./selection";

export interface PuzleMenuContext {
	view: MarkdownView;
	file: TFile;
	/** 菜单弹出那一刻的选区快照；点菜单项会让阅读模式的 DOM 选区消失，所以不能等到点击时再取 */
	selection: SelectionContext | null;
	/** 阅读模式（预览）还是编辑模式 */
	reading: boolean;
}

export interface PuzleMenuItem {
	title: string;
	icon: string;
	onClick(): void;
}

export type PuzleMenuContributor = (ctx: PuzleMenuContext) => PuzleMenuItem[];

/**
 * Puzle 的右键菜单。各 feature 只管往这里注册菜单项，编辑模式与阅读模式共用同一份实现：
 * - 编辑模式挂 `editor-menu`（Obsidian 官方事件，菜单里和别的插件混排）；
 * - 阅读模式没有对应事件，只能自己听预览区的 `contextmenu` 再弹一个 Menu ——
 *   同步笔记默认以阅读模式打开，这条路径才是日常用的那条。
 */
export class PuzleContextMenu {
	private readonly contributors: PuzleMenuContributor[] = [];

	register(contributor: PuzleMenuContributor): void {
		this.contributors.push(contributor);
	}

	build(ctx: PuzleMenuContext): PuzleMenuItem[] {
		const items: PuzleMenuItem[] = [];
		for (const contributor of this.contributors) {
			try {
				items.push(...contributor(ctx));
			} catch {
				// 某个 feature 出错不该整份菜单都弹不出来
			}
		}
		return items;
	}

	attach(plugin: Plugin): void {
		plugin.registerEvent(
			plugin.app.workspace.on("editor-menu", (menu: Menu, _editor: Editor, view) => {
				if (!(view instanceof MarkdownView) || !view.file) return;
				const items = this.build({
					view,
					file: view.file,
					selection: getSelectionContext(view),
					reading: false
				});
				for (const item of items) addItem(menu, item);
			})
		);

		plugin.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const view = readingViewAt(plugin, target);
			if (!view?.file) return;
			const items = this.build({
				view,
				file: view.file,
				selection: getSelectionContext(view),
				reading: true
			});
			if (items.length === 0) return;
			const menu = new Menu();
			for (const item of items) addItem(menu, item);
			event.preventDefault();
			menu.showAtMouseEvent(event);
		});
	}
}

function addItem(menu: Menu, entry: PuzleMenuItem): void {
	menu.addItem((item) => {
		item.setTitle(entry.title).setIcon(entry.icon).onClick(entry.onClick);
	});
}

/** 命中的是不是某个阅读模式 Markdown 视图的正文区域 */
function readingViewAt(plugin: Plugin, target: HTMLElement): MarkdownView | null {
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		if (view.getMode() !== "preview") continue;
		if (view.contentEl.contains(target)) return view;
	}
	return null;
}
