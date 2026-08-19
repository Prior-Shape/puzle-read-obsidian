// Puzle Read 插件的真机 E2E：在真实 Obsidian 中驱动插件，对接本地 mock 后端。
// 用法：node e2e/run.mjs [用例名过滤]

import { connectToSettingsWindow, connectToVault, sleep, waitFor } from "./cdp.mjs";

const VAULT = "/tmp/puzle-e2e-vault";
const MOCK = "http://127.0.0.1:8787";
const filter = process.argv[2] ?? "";

const results = [];
let session;

// ---------------------------------------------------------------- 工具

const control = (patch) =>
	fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(patch) }).then((r) => r.json());
const resetMock = () => fetch(`${MOCK}/__reset`).then((r) => r.json());
const mockState = () => fetch(`${MOCK}/__control`).then((r) => r.json());
const dropSockets = () => fetch(`${MOCK}/__drop-sockets`).then((r) => r.json());

/** 在插件内部执行代码：p = 插件实例。 */
const inPlugin = (body) => session.evaluate(`const p = app.plugins.plugins['puzle-read']; ${body}`);

async function resetVault() {
	// 删掉同步产物与插件状态，回到干净起点
	await inPlugin(`
		const root = app.vault.getAbstractFileByPath('PuzleRead');
		if (root) await app.fileManager.trashFile(root);
		p.data.syncState = { lastSyncAt: null, articles: {}, highlights: {}, chats: {}, continuationChatId: null };
		p.data.settings.baseUrl = ${JSON.stringify(MOCK)};
		p.data.settings.token = 'e2e-valid-token';
		p.data.settings.rootFolder = 'PuzleRead';
		p.data.settings.injectAnchors = true;
		p.data.settings.keepThinking = true;
		p.data.settings.onEditedManaged = 'overwrite';
		p.data.settings.autoSyncMinutes = 0;
		await p.saveSettings();
		return true;
	`);
	// 清掉遗留的聊天视图与 socket
	await inPlugin(`
		for (const leaf of app.workspace.getLeavesOfType('puzle-chat-view')) leaf.detach();
		p.socket?.disconnect?.();
		p.socket = null;
		return true;
	`);
	await resetMock();
	await sleep(300);
}

function assert(cond, message) {
	if (!cond) throw new Error(message);
}

async function test(name, fn) {
	if (filter && !name.includes(filter)) return;
	process.stdout.write(`\n▶ ${name}\n`);
	const started = Date.now();
	try {
		await resetVault();
		await fn();
		const ms = Date.now() - started;
		results.push({ name, ok: true, ms });
		process.stdout.write(`  ✅ 通过 (${ms}ms)\n`);
	} catch (err) {
		const ms = Date.now() - started;
		results.push({ name, ok: false, ms, error: err.message });
		process.stdout.write(`  ❌ 失败 (${ms}ms): ${err.message}\n`);
	}
}

const runCommand = (id) => inPlugin(`app.commands.executeCommandById('puzle-read:${id}'); return true;`);

const readFile = (path) =>
	session.evaluate(`
		const f = app.vault.getFileByPath(${JSON.stringify(path)});
		if (!f) return null;
		return await app.vault.read(f);
	`);

const listFiles = () =>
	session.evaluate(
		`return app.vault.getFiles().map(f => f.path).filter(p => p.startsWith('PuzleRead')).sort();`
	);

/**
 * 在设置 popout 窗口里点「测试连接」并收集通知。
 * 注意：Notice 渲染在设置窗口内（不是主窗口），且 5s 后自动消失，必须高频轮询。
 */
async function clickTestConnection() {
	await session.evaluate(`app.setting.open(); app.setting.openTabById('puzle-read'); return true;`);
	const settings = await connectToSettingsWindow();
	try {
		await waitFor(
			settings,
			`[...document.querySelectorAll('button')].some(b => b.textContent.includes('测试连接'))`,
			{ timeoutMs: 8000, label: "设置页渲染出测试连接按钮" }
		);
		await settings.evaluate(`
			const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('测试连接'));
			btn.click();
			return true;
		`);
		for (let i = 0; i < 80; i++) {
			const list = await settings.evaluate(
				`return [...document.querySelectorAll('.notice')].map(n => n.innerText);`
			);
			if (list.length) return list;
			await sleep(150);
		}
		return [];
	} finally {
		settings.close();
	}
}

// ---------------------------------------------------------------- 用例

await (async () => {
	session = await connectToVault(VAULT);
	console.log(`已连接沙箱 vault: ${VAULT}`);

	// ============ 1. 同步链路 ============
	await test("同步：全量同步生成文章/高亮/对话与 Base 视图", async () => {
		await runCommand("puzle-full-sync");
		await waitFor(session, `app.vault.getFiles().filter(f=>f.path.startsWith('PuzleRead')).length >= 6`, {
			timeoutMs: 20000,
			label: "同步产物出现"
		});
		await sleep(800);
		const files = await listFiles();
		console.log("     产物:", files.join(", "));

		assert(files.some((f) => f.includes("如何阅读一本书")), "缺少链接文章笔记");
		assert(files.some((f) => f.includes("深度工作")), "缺少文件类文章笔记");
		assert(!files.some((f) => f.includes("还在解析中")), "未完成状态的文章不应被同步");
		assert(files.filter((f) => f.startsWith("PuzleRead/Highlights/")).length === 2, "应有 2 条高亮笔记");
		assert(files.some((f) => f.includes("关于阅读层次的讨论")), "缺少对话笔记");
		assert(files.includes("PuzleRead/Articles.base"), "缺少 Articles.base");
		assert(files.includes("PuzleRead/Highlights.base"), "缺少 Highlights.base");

		const article = await readFile("PuzleRead/Articles/如何阅读一本书 (r101).md");
		assert(article.includes("puzle_type: article"), "frontmatter 缺 puzle_type");
		assert(article.includes("reading_id: 101"), "frontmatter 缺 reading_id");
		assert(article.includes("%% puzle:begin %%") && article.includes("%% puzle:end %%"), "缺 managed 标记");
		assert(article.includes("核心观点"), "缺 AI 摘要 callout");
		assert(article.includes("这个分层框架很实用"), "缺文章级评论");
		assert(article.includes("==阅读可以分为四个层次=="), "高亮锚点未注入正文");
		assert(article.includes("💬"), "高亮锚点缺少跳转角标");

		const chat = await readFile("PuzleRead/Chats/关于阅读层次的讨论 (c214).md");
		assert(chat.includes("共四个层次"), "对话缺 assistant 内容");
		assert(chat.includes("🧠 思考过程"), "keepThinking=true 时应渲染思考过程");
	});

	await test("同步：增量同步跳过未变条目（指纹短路）", async () => {
		await runCommand("puzle-full-sync");
		await waitFor(session, `app.vault.getFiles().filter(f=>f.path.startsWith('PuzleRead')).length >= 6`, {
			timeoutMs: 20000
		});
		await sleep(800);

		await fetch(`${MOCK}/__control`, { method: "POST", body: "{}" });
		const before = (await mockState()).requests.length;
		await runCommand("puzle-incremental-sync");
		await sleep(2500);
		const after = (await mockState()).requests;
		const detailCalls = after
			.slice(before)
			.filter((r) => /\/reading\/(link|file)\/\d+$/.test(r.path));
		console.log(`     增量新增请求 ${after.length - before} 条，其中详情请求 ${detailCalls.length} 条`);
		assert(detailCalls.length === 0, `增量应跳过详情拉取，实际发生 ${detailCalls.length} 次`);
	});

	await test("同步：全量同步无条件重建（本次修复的兜底语义）", async () => {
		await runCommand("puzle-full-sync");
		await waitFor(session, `app.vault.getFiles().filter(f=>f.path.startsWith('PuzleRead')).length >= 6`, {
			timeoutMs: 20000
		});
		await sleep(800);

		const before = (await mockState()).requests.length;
		await runCommand("puzle-full-sync");
		await sleep(3000);
		const after = (await mockState()).requests;
		const detailCalls = after.slice(before).filter((r) => /\/reading\/(link|file)\/\d+$/.test(r.path));
		console.log(`     第二次全量的详情请求 ${detailCalls.length} 条`);
		assert(detailCalls.length >= 2, `全量应无条件重建，实际详情请求仅 ${detailCalls.length} 次`);
	});

	await test("同步：managed 区外的用户内容不被覆盖", async () => {
		await runCommand("puzle-full-sync");
		await waitFor(session, `app.vault.getFiles().filter(f=>f.path.startsWith('PuzleRead')).length >= 6`, {
			timeoutMs: 20000
		});
		await sleep(800);

		const path = "PuzleRead/Articles/如何阅读一本书 (r101).md";
		await session.evaluate(`
			const f = app.vault.getFileByPath(${JSON.stringify(path)});
			await app.vault.process(f, (d) => d + '\\n\\n## 我的笔记\\n这段是用户写的，绝不能丢。\\n');
			return true;
		`);
		await runCommand("puzle-full-sync");
		await sleep(3000);
		const content = await readFile(path);
		assert(content.includes("这段是用户写的，绝不能丢"), "managed 区外的用户内容被覆盖了");
		assert(content.includes("%% puzle:begin %%"), "managed 区丢失");
	});

	// ============ 2. 本次修复的 WS 稳健性 ============
	await test("修复验证：chat_history 返回空页且 has_more=true 时不死循环", async () => {
		await control({ historyEmptyPageLoop: true });
		const before = (await mockState()).wsFrames.length;

		await inPlugin(`
			const socket = p.getSocket();
			p._e2eHistory = 'pending';
			socket.requestFullChatHistory(214).then(r => { p._e2eHistory = 'resolved:' + (r ? (r.turns||[]).length : 'null'); })
			                                  .catch(e => { p._e2eHistory = 'rejected:' + e.message; });
			return true;
		`);
		await waitFor(session, `app.plugins.plugins['puzle-read']._e2eHistory !== 'pending'`, {
			timeoutMs: 12000,
			label: "requestFullChatHistory 返回"
		});
		const outcome = await inPlugin(`return p._e2eHistory;`);
		await sleep(1200);
		const frames = (await mockState()).wsFrames.slice(before).filter((f) => f.msg?.type === "chat_history");
		console.log(`     结果: ${outcome}；期间发出 chat_history 请求 ${frames.length} 次`);
		assert(outcome.startsWith("resolved"), `应正常返回，实际 ${outcome}`);
		assert(frames.length <= 2, `空页应立即终止，实际请求了 ${frames.length} 次（旧实现会无限循环）`);
	});

	await test("修复验证：设置变更后 socket 仍可用（不再被 dispose 卡死）", async () => {
		await inPlugin(`await p.getSocket().connect(); return true;`);
		await sleep(500);

		// 改设置 → 旧实现会 disconnect 并置 null，导致已持有引用的消费者永久失效
		const sameInstance = await inPlugin(`
			const before = p.getSocket();
			p.data.settings.token = 'e2e-valid-token';
			p.data.settings.baseUrl = ${JSON.stringify(MOCK)} + '/';
			await p.saveSettings();
			const after = p.getSocket();
			p._e2eSocketSame = before === after;
			return before === after;
		`);
		assert(sameInstance, "设置变更后 socket 实例被替换了（旧行为）");

		// 变更后仍能正常完成一次请求
		await inPlugin(`
			p._e2eAfterChange = 'pending';
			p.getSocket().requestChatHistory(214, 0, 40)
				.then(r => { p._e2eAfterChange = 'ok:' + (r.turns||[]).length; })
				.catch(e => { p._e2eAfterChange = 'err:' + e.message; });
			return true;
		`);
		await waitFor(session, `app.plugins.plugins['puzle-read']._e2eAfterChange !== 'pending'`, {
			timeoutMs: 15000,
			label: "设置变更后的 WS 请求返回"
		});
		const res = await inPlugin(`return p._e2eAfterChange;`);
		console.log(`     变更后请求结果: ${res}`);
		assert(res.startsWith("ok:"), `设置变更后 WS 请求应成功，实际 ${res}`);
	});

	// ============ 3. 聊天面板 ============
	await test("聊天：打开面板、发送消息、流式渲染、会话落库、写回对话笔记", async () => {
		await inPlugin(`app.commands.executeCommandById('puzle-read:open-puzle-chat'); return true;`);
		await waitFor(session, `document.querySelector('.puzle-chat') !== null`, {
			timeoutMs: 10000,
			label: "聊天面板挂载"
		});
		await waitFor(session, `document.querySelector('.puzle-chat-input') !== null`, { timeoutMs: 5000 });

		// 通过 React 的原生 setter 输入并触发 change
		await session.evaluate(`
			const ta = document.querySelector('.puzle-chat-input');
			const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
			setter.call(ta, '你好，介绍一下阅读层次');
			ta.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		`);
		await sleep(300);
		await session.evaluate(`
			const btn = document.querySelector('.puzle-chat-send');
			if (!btn || btn.disabled) throw new Error('发送按钮不可用');
			btn.click();
			return true;
		`);

		await waitFor(session, `document.querySelectorAll('.puzle-chat-message-user').length >= 1`, {
			timeoutMs: 8000,
			label: "用户消息上屏"
		});
		await waitFor(session, `document.querySelector('.puzle-chat-stop') !== null`, {
			timeoutMs: 8000,
			label: "进入流式（出现停止按钮）"
		});
		await waitFor(
			session,
			`(document.querySelector('.puzle-chat-message-assistant .puzle-chat-markdown')?.innerText || '').includes('mock')`,
			{ timeoutMs: 15000, label: "assistant 流式文本渲染" }
		);
		await waitFor(session, `document.querySelector('.puzle-chat-send') !== null`, {
			timeoutMs: 15000,
			label: "流式结束恢复发送按钮"
		});

		const text = await session.evaluate(
			`return document.querySelector('.puzle-chat-message-assistant .puzle-chat-markdown').innerText;`
		);
		console.log(`     assistant 回复: ${text.slice(0, 60)}`);
		assert(text.includes("mock"), "assistant 回复内容不符");

		const titled = await session.evaluate(
			`return [...document.querySelectorAll('.puzle-chat-session-select option')].map(o=>o.textContent);`
		);
		console.log(`     会话下拉: ${titled.join(" | ")}`);
		assert(titled.some((t) => t.includes("Mock 生成的标题")), "title_generated 未反映到会话列表");

		// 说完一轮就地写回 Chats/*.md：聊天在右边栏，留档看 Markdown
		await waitFor(
			session,
			`app.vault.getFiles().some(f=>f.path.startsWith('PuzleRead/Chats/') && f.path.includes('Mock 生成的标题'))`,
			{ timeoutMs: 10000, label: "对话笔记写回" }
		);
		const note = await inPlugin(`
			const f = app.vault.getFiles().find(f=>f.path.includes('Mock 生成的标题'));
			const chatId = Number(f.path.match(/\\(c(\\d+)\\)/)[1]);
			return { path: f.path, content: await app.vault.read(f), state: p.data.syncState.chats[chatId] };
		`);
		console.log(`     对话笔记: ${note.path}`);
		assert(note.content.includes("你好，介绍一下阅读层次"), "对话笔记缺用户提问");
		assert(note.content.includes("mock 后端的流式回复"), "对话笔记缺 assistant 回复");
		assert(note.content.includes("%% puzle:begin %%"), "对话笔记缺 managed 标记");
		assert(note.state && note.state.turnCount === 1, "对话笔记未记入同步状态");
	});

	await test("修复验证：流式中断线时面板复位而非永久卡死", async () => {
		await inPlugin(`app.commands.executeCommandById('puzle-read:open-puzle-chat'); return true;`);
		await waitFor(session, `document.querySelector('.puzle-chat-input') !== null`, { timeoutMs: 10000 });

		await control({ streamMode: "slow" });
		await session.evaluate(`
			const ta = document.querySelector('.puzle-chat-input');
			const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
			setter.call(ta, '慢速回复用于断线测试');
			ta.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		`);
		await sleep(200);
		await session.evaluate(`document.querySelector('.puzle-chat-send').click(); return true;`);
		await waitFor(session, `document.querySelector('.puzle-chat-stop') !== null`, {
			timeoutMs: 10000,
			label: "进入流式"
		});

		// 真断线：服务端直接 destroy TCP，不发 close 帧
		await dropSockets();

		await waitFor(session, `document.querySelector('.puzle-chat-error') !== null`, {
			timeoutMs: 15000,
			label: "断线后出现错误提示"
		});
		await waitFor(session, `document.querySelector('.puzle-chat-send') !== null`, {
			timeoutMs: 15000,
			label: "断线后恢复可发送状态（旧实现会永久卡在停止按钮）"
		});
		const err = await session.evaluate(`return document.querySelector('.puzle-chat-error')?.innerText || '';`);
		console.log(`     错误提示: ${err}`);
		assert(err.includes("连接已断开"), `错误提示不符: ${err}`);
		const inputDisabled = await session.evaluate(
			`return document.querySelector('.puzle-chat-input').disabled;`
		);
		assert(inputDisabled === false, "断线后输入框仍被禁用（卡死）");
	});

	// ============ 4. 设置页 ============
	await test("设置：测试连接按钮走通鉴权链路", async () => {
		const list = await clickTestConnection();
		console.log(`     通知: ${list.join(" | ")}`);
		assert(list.some((n) => n.includes("连接成功")), `未出现连接成功提示: ${JSON.stringify(list)}`);
		assert(list.some((n) => n.includes("e2e-tester")), "未回显 mock 用户名");
		await session.evaluate(`app.setting.close(); return true;`);
	});

	await test("设置：token 失效时给出明确提示", async () => {
		await inPlugin(`p.data.settings.token = 'wrong-token'; await p.saveSettings(); return true;`);
		const list = await clickTestConnection();
		console.log(`     通知: ${list.join(" | ")}`);
		assert(list.some((n) => n.includes("Token 已失效")), `未提示 Token 失效: ${JSON.stringify(list)}`);
		await session.evaluate(`app.setting.close(); return true;`);
		await inPlugin(`p.data.settings.token = 'e2e-valid-token'; await p.saveSettings(); return true;`);
	});

	// ---------------------------------------------------------------- 汇总
	const consoleErrors = await session.evaluate(`return window.__puzleE2eErrors || [];`);
	if (consoleErrors.length) console.log("\n页面错误:", consoleErrors);

	session.close();

	console.log("\n" + "=".repeat(64));
	const passed = results.filter((r) => r.ok).length;
	for (const r of results) {
		console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n     ${r.error}`}`);
	}
	console.log("=".repeat(64));
	console.log(`${passed}/${results.length} 通过`);
	process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
	console.error("\n运行器异常:", err);
	session?.close();
	process.exit(2);
});
