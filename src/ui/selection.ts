import { MarkdownView } from "obsidian";

export interface SelectionContext {
	/** 整篇文档的可见文本（编辑模式是 Markdown 源码，阅读模式是渲染后文本） */
	docText: string;
	/** 选区在 docText 中的 UTF-16 偏移，闭开区间 */
	start: number;
	end: number;
	/** 选中的原始文本 */
	selected: string;
}

/**
 * 取当前选区。编辑模式走 Editor（拿得到精确偏移），
 * 阅读模式走 DOM Range —— 同步笔记默认以阅读模式打开，不支持这条路径就等于没法划词。
 */
export function getSelectionContext(view: MarkdownView): SelectionContext | null {
	const editorSelection = readEditorSelection(view);
	if (editorSelection) return editorSelection;
	return readDomSelection(view);
}

function readEditorSelection(view: MarkdownView): SelectionContext | null {
	if (view.getMode() !== "source") return null;
	const editor = view.editor;
	const selected = editor.getSelection();
	if (!selected.trim()) return null;
	const from = editor.posToOffset(editor.getCursor("from"));
	const to = editor.posToOffset(editor.getCursor("to"));
	return { docText: editor.getValue(), start: from, end: to, selected };
}

function readDomSelection(view: MarkdownView): SelectionContext | null {
	const root = view.contentEl;
	const win = root.ownerDocument?.defaultView ?? window;
	const selection = win.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return null;

	const full = root.ownerDocument.createRange();
	full.selectNodeContents(root);
	const docText = full.toString();

	const before = range.cloneRange();
	before.selectNodeContents(root);
	before.setEnd(range.startContainer, range.startOffset);
	const start = before.toString().length;

	const selected = range.toString();
	if (!selected.trim()) return null;
	return { docText, start, end: start + selected.length, selected };
}
