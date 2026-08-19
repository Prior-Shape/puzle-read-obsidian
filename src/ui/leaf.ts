import { MarkdownView } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";

export type LeafSlot = "left" | "right" | "main";

/** 打开（或复用）某个视图类型的 leaf。各 feature 共用，避免互相 import。 */
export async function activateLeaf(app: App, viewType: string, slot: LeafSlot): Promise<void> {
	const workspace = app.workspace;
	const existing = workspace.getLeavesOfType(viewType);
	const leaf: WorkspaceLeaf | null =
		existing.length > 0
			? existing[0]
			: slot === "left"
				? workspace.getLeftLeaf(false)
				: slot === "right"
					? workspace.getRightLeaf(false)
					: workspace.getLeaf(true);
	if (!leaf) return;
	await leaf.setViewState({ type: viewType, active: true });
	await workspace.revealLeaf(leaf);
}

/**
 * 取「当前正在看的」Markdown 视图。
 * 直接用 getActiveViewOfType 不够：焦点一旦落到侧边栏视图（批注面板、聊天面板）上，
 * 它就返回 null —— 而 getActiveFile() 仍然指向那篇笔记，所以回退到按文件找 markdown leaf。
 */
export function getActiveMarkdownView(app: App): MarkdownView | null {
	const direct = app.workspace.getActiveViewOfType(MarkdownView);
	if (direct) return direct;
	const file = app.workspace.getActiveFile();
	if (!file) return null;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as MarkdownView;
		if (view.file?.path === file.path) return view;
	}
	return null;
}
