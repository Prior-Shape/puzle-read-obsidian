import { Notice } from "obsidian";
import type { Editor, Plugin } from "obsidian";
import type { PuzleSocket } from "../core/ws/manager";
import type { PluginDeps } from "../deps";
import { SyncStore } from "../sync/store";
import {
	CONTINUE_COMMAND_ID,
	CONTINUE_COMMAND_NAME,
	CONTINUE_MENU_LABEL,
	CONTINUE_STATUS_LABEL,
	ContinueWriter,
	extractContinuePrefix
} from "./continue";
import type { ContinueWriterEditor } from "./continue";

export function registerWriterFeature(plugin: Plugin, deps: PluginDeps): void {
	const store = new SyncStore({ getData: deps.getData, saveData: deps.saveData });
	let controller: ContinueWriter | null = null;
	let boundSocket: PuzleSocket | null = null;

	const statusItem = plugin.addStatusBarItem();
	statusItem.setText(CONTINUE_STATUS_LABEL);
	statusItem.style.display = "none";
	statusItem.addEventListener("click", () => {
		controller?.stop();
	});

	const getController = (): ContinueWriter => {
		const socket = deps.getSocket();
		if (!controller || boundSocket !== socket) {
			controller?.dispose();
			boundSocket = socket;
			controller = new ContinueWriter(socket, store, {
				logger: deps.logger,
				notice: (message) => new Notice(message),
				onRunningChange: (running) => {
					statusItem.style.display = running ? "" : "none";
				}
			});
		}
		return controller;
	};

	const run = (editor: Editor): void => {
		const writer = getController();
		if (writer.isRunning) {
			writer.stop();
			return;
		}
		const cursor = editor.getCursor();
		const beforeCursor = editor.getRange({ line: 0, ch: 0 }, cursor);
		const prefix = extractContinuePrefix(beforeCursor, deps.getSettings().continueMaxChars);
		const insertAt = editor.posToOffset(cursor);
		const editorPort: ContinueWriterEditor = {
			replaceRange: (text, from, to) => {
				editor.replaceRange(text, editor.offsetToPos(from), editor.offsetToPos(to));
			}
		};
		writer.start(editorPort, insertAt, prefix);
	};

	plugin.addCommand({
		id: CONTINUE_COMMAND_ID,
		name: CONTINUE_COMMAND_NAME,
		editorCallback: (editor) => {
			run(editor);
		}
	});

	plugin.registerEvent(
		plugin.app.workspace.on("editor-menu", (menu, editor) => {
			menu.addItem((item) => {
				item.setTitle(CONTINUE_MENU_LABEL).setIcon("sparkles").onClick(() => run(editor));
			});
		})
	);

	plugin.register(() => {
		controller?.dispose();
		controller = null;
		boundSocket = null;
	});
}
