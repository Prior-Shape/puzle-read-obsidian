import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import type { MarkdownView } from "obsidian";
import { PuzleContextMenu } from "../../src/ui/context-menu";
import type { PuzleMenuContext } from "../../src/ui/context-menu";
import type { SelectionContext } from "../../src/ui/selection";

function makeContext(selection: SelectionContext | null, reading = true): PuzleMenuContext {
	const file = new TFile();
	file.path = "PuzleRead/Articles/a.md";
	return { view: {} as MarkdownView, file, selection, reading };
}

const SELECTION: SelectionContext = {
	docText: "基础阅读是第一层。",
	start: 0,
	end: 4,
	selected: "基础阅读"
};

describe("PuzleContextMenu", () => {
	it("按注册顺序汇总各 feature 的菜单项", () => {
		const menu = new PuzleContextMenu();
		menu.register(({ selection }) =>
			selection ? [{ title: "创建高亮", icon: "highlighter", onClick: () => undefined }] : []
		);
		menu.register(({ selection }) => [
			{
				title: selection ? "就这段提问" : "与本文对话",
				icon: "message-square",
				onClick: () => undefined
			}
		]);

		expect(menu.build(makeContext(SELECTION)).map((item) => item.title)).toEqual([
			"创建高亮",
			"就这段提问"
		]);
		expect(menu.build(makeContext(null)).map((item) => item.title)).toEqual(["与本文对话"]);
	});

	it("贡献者能按模式区分：只在编辑器里能干的活不进阅读模式菜单", () => {
		const menu = new PuzleContextMenu();
		menu.register(({ reading }) =>
			reading ? [] : [{ title: "改写这段", icon: "pencil", onClick: () => undefined }]
		);

		expect(menu.build(makeContext(null, true))).toEqual([]);
		expect(menu.build(makeContext(null, false)).map((item) => item.title)).toEqual(["改写这段"]);
	});

	it("某个 feature 抛错不影响其他菜单项", () => {
		const menu = new PuzleContextMenu();
		menu.register(() => {
			throw new Error("boom");
		});
		menu.register(() => [{ title: "与本文对话", icon: "message-square", onClick: () => undefined }]);

		expect(menu.build(makeContext(null)).map((item) => item.title)).toEqual(["与本文对话"]);
	});

	it("没有任何贡献项时返回空数组（调用方据此不弹菜单）", () => {
		expect(new PuzleContextMenu().build(makeContext(SELECTION))).toEqual([]);
	});
});
