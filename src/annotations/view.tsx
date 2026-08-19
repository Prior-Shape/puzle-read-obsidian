import { ItemView } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AnnotationsPanel } from "./components/AnnotationsPanel";
import type { AnnotationsController } from "./controller";

export const VIEW_TYPE_ANNOTATIONS = "puzle-annotations";

export interface AnnotationsViewDeps {
	getController(): AnnotationsController;
	reveal(snippet: string): void;
	askAboutSelection(snippet: string): void;
	/** 视图挂载时主动对齐一次当前文章：布局恢复时不会有 file-open 事件 */
	syncActiveArticle(): void;
}

export class AnnotationsView extends ItemView {
	private root: Root | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: AnnotationsViewDeps
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_ANNOTATIONS;
	}

	getDisplayText(): string {
		return "Puzle 批注";
	}

	getIcon(): string {
		return "highlighter";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("puzle-annotations-root");
		this.deps.syncActiveArticle();
		this.root = createRoot(this.contentEl);
		this.root.render(
			<AnnotationsPanel
				getController={this.deps.getController}
				onReveal={this.deps.reveal}
				onAskAboutSelection={this.deps.askAboutSelection}
			/>
		);
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
		this.root = null;
	}
}
