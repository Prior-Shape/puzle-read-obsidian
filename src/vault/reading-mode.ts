import { MarkdownView, TFile } from "obsidian";
import type { Plugin } from "obsidian";
import type { PluginDeps } from "../deps";

/**
 * Obsidian 没有「文件只读」API，能做到的最接近的是：打开同步笔记时强制切到阅读视图。
 * 用户仍可 Cmd/Ctrl+E 切回编辑（managed 区外的自由笔记是设计的一部分），
 * 这里只负责挡住「点开就手滑改正文」。
 */
export function registerReadingMode(plugin: Plugin, deps: PluginDeps): void {
	plugin.registerEvent(
		plugin.app.workspace.on("file-open", (file: TFile | null) => {
			if (!file) return;
			if (!deps.getSettings().readingMode) return;
			if (!isSyncedNote(plugin, deps, file)) return;
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || view.file?.path !== file.path) return;
			void forcePreview(view);
		})
	);
}

export function isUnderRoot(path: string, rootFolder: string): boolean {
	const root = rootFolder.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!root) return false;
	return path === root || path.startsWith(`${root}/`);
}

function isSyncedNote(plugin: Plugin, deps: PluginDeps, file: TFile): boolean {
	if (file.extension !== "md") return false;
	if (isUnderRoot(file.path, deps.getSettings().rootFolder)) return true;
	// 文件被移出根目录后仍按 frontmatter 认；插件本来就靠 id 而不是路径定位
	const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
	return typeof frontmatter?.puzle_type === "string";
}

async function forcePreview(view: MarkdownView): Promise<void> {
	const state = view.leaf.getViewState();
	const mode = (state.state as { mode?: unknown } | undefined)?.mode;
	if (mode === "preview") return;
	await view.leaf.setViewState({
		...state,
		state: { ...(state.state ?? {}), mode: "preview" }
	});
}
