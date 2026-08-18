// 全链路 E2E：真实 Obsidian × 真实 Puzle 后端。
//
// ⚠️ 这里包含写路径（chat_completion / AI 续写），会在账号里产生真实会话。
// 只在明确授权时运行。用法：node e2e/run-live.mjs [用例名过滤]

import { connectToSettingsWindow, connectToVault, sleep, waitFor } from "./cdp.mjs";

const VAULT = "/tmp/puzle-e2e-vault";
const filter = process.argv[2] ?? "";
const results = [];
let session;
const createdChats = [];

const inPlugin = (body) => session.evaluate(`const p = app.plugins.plugins['puzle-read']; ${body}`);

function assert(cond, message) {
	if (!cond) throw new Error(message);
}

async function test(name, fn) {
	if (filter && !name.includes(filter)) return;
	process.stdout.write(`\n▶ ${name}\n`);
	const started = Date.now();
	try {
		await fn();
		results.push({ name, ok: true, ms: Date.now() - started });
		process.stdout.write(`  ✅ 通过 (${Date.now() - started}ms)\n`);
	} catch (err) {
		results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
		process.stdout.write(`  ❌ 失败 (${Date.now() - started}ms): ${err.message}\n`);
	}
}

/** 还原被测试打过补丁的分页迭代器，避免用例之间互相污染。 */
const restoreIterator = () =>
	inPlugin(`
		const c = p.client;
		if (c.__origIterate) { c.iterateAllReadingItems = c.__origIterate; delete c.__origIterate; }
		return true;
	`);

/**
 * 打开聊天面板。fresh=true 时先关掉已有面板，强制 React 重新挂载，
 * 这样 loadSessions() 会重新跑（否则复用旧状态，断言的是上一轮的残留）。
 */
async function openChatPanel({ fresh = false } = {}) {
	if (fresh) {
		await inPlugin(`
			for (const leaf of app.workspace.getLeavesOfType('puzle-chat-view')) leaf.detach();
			return true;
		`);
		await sleep(400);
	}
	await inPlugin(`app.commands.executeCommandById('puzle-read:open-puzle-chat'); return true;`);
	await waitFor(session, `document.querySelector('.puzle-chat-input') !== null`, {
		timeoutMs: 15000,
		label: "聊天面板挂载"
	});
}

async function typeAndSend(text) {
	await session.evaluate(`
		const ta = document.querySelector('.puzle-chat-input');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
		setter.call(ta, ${JSON.stringify(text)});
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	`);
	await sleep(200);
	await session.evaluate(`
		const btn = document.querySelector('.puzle-chat-send');
		if (!btn) throw new Error('发送按钮不存在');
		if (btn.disabled) throw new Error('发送按钮被禁用');
		btn.click();
		return true;
	`);
}

const assistantText = () =>
	session.evaluate(`
		const nodes = [...document.querySelectorAll('.puzle-chat-message-assistant .puzle-chat-markdown')];
		return nodes.length ? nodes[nodes.length - 1].innerText : '';
	`);

/**
 * 直接 await 控制器的 loadSessions()，避免对 DOM 轮询时命中重新挂载前的旧
 * sessions（面板挂载会先用控制器现有状态渲染，加载 199 条要几秒）。
 */
const reloadSessions = () =>
	inPlugin(`
		const view = app.workspace.getLeavesOfType('puzle-chat-view')[0]?.view;
		if (!view) throw new Error('聊天面板未打开');
		const ctrl = view.getController();
		await ctrl.loadSessions();
		return ctrl.getState().sessions.length;
	`);

async function openNoteForEditing(name, body) {
	await session.evaluate(`
		const existing = app.vault.getFileByPath(${JSON.stringify(name)});
		if (existing) await app.fileManager.trashFile(existing);
		const f = await app.vault.create(${JSON.stringify(name)}, ${JSON.stringify(body)});
		const leaf = app.workspace.getLeaf(true);
		await leaf.openFile(f, { active: true, state: { mode: 'source' } });
		app.workspace.setActiveLeaf(leaf, { focus: true });
		return true;
	`);
	await waitFor(session, `!!app.workspace.activeEditor?.editor`, { timeoutMs: 10000, label: "编辑器就绪" });
	await session.evaluate(`
		const ed = app.workspace.activeEditor.editor;
		const last = ed.lastLine();
		ed.setCursor({ line: last, ch: ed.getLine(last).length });
		return true;
	`);
}

const writerRunning = () =>
	session.evaluate(`
		const el = document.querySelector('.status-bar-item.plugin-puzle-read');
		return !!el && el.style.display !== 'none';
	`);

await (async () => {
	session = await connectToVault(VAULT);
	console.log(`已连接沙箱 vault: ${VAULT}`);
	console.log("⚠️  本次会在真实账号产生会话记录\n");
	// 上一轮可能中途失败留下补丁，先还原到干净状态
	await restoreIterator();

	// ============ 只读链路 ============
	await test("只读：REST 鉴权与列表分页", async () => {
		const r = await inPlugin(`
			const c = p.client;
			const profile = await c.getProfile();
			const page1 = await c.listReadingItems({ page: 1, page_size: 20 });
			const page2 = await c.listReadingItems({ page: 2, page_size: 20 });
			return {
				username: profile.username,
				total: page1.total,
				p1: page1.items.length,
				p2: page2.items.length,
				overlap: page1.items.filter(a => page2.items.some(b => b.id === a.id)).length
			};
		`);
		console.log(`     用户=${r.username} 总数=${r.total} 第1页=${r.p1} 第2页=${r.p2} 重叠=${r.overlap}`);
		assert(r.username === "卢书洋", "profile 用户名不符");
		assert(r.total > 0 && r.p1 > 0 && r.p2 > 0, "分页返回为空");
		assert(r.overlap === 0, "分页出现重复条目");
	});

	await test("只读：WS 鉴权、心跳与历史全量拉取", async () => {
		const r = await inPlugin(`
			const socket = p.getSocket();
			await socket.connect();
			const full = await socket.requestFullChatHistory(762);
			return {
				connected: socket.isConnected,
				turns: (full?.turns ?? []).length,
				title: full?.title ?? null,
				hasMore: full?.has_more
			};
		`);
		console.log(`     已连接=${r.connected} 标题=${JSON.stringify(r.title)} turns=${r.turns}`);
		assert(r.connected, "WS 未连接");
		assert(r.turns > 0, "历史 turns 为空");
		assert(r.hasMore === false, "全量拉取后 has_more 应为 false");
	});

	await test("只读：会话列表加载真实会话", async () => {
		await restoreIterator();
		await openChatPanel({ fresh: true });
		const count = await reloadSessions();
		await waitFor(
			session,
			`document.querySelectorAll('.puzle-chat-session-select option').length === ${count + 1}`,
			{ timeoutMs: 15000, label: "会话渲染到下拉框" }
		);
		const opts = await session.evaluate(
			`return [...document.querySelectorAll('.puzle-chat-session-select option')].map(o=>o.textContent);`
		);
		console.log(`     加载到 ${count} 个会话，下拉框渲染 ${opts.length - 1} 项`);
		console.log(`     前几个: ${opts.slice(1, 5).join(" / ")}`);
		assert(count >= 10, `会话数偏少: ${count}`);
		assert(opts.length - 1 === count, "下拉框与状态不一致");
	});

	await test("只读：打开既有会话并渲染历史", async () => {
		await restoreIterator();
		await openChatPanel({ fresh: true });
		await reloadSessions();
		await session.evaluate(`
			const sel = document.querySelector('.puzle-chat-session-select');
			const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
			setter.call(sel, '762');
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		`);
		await waitFor(session, `document.querySelectorAll('.puzle-chat-message').length >= 2`, {
			timeoutMs: 25000,
			label: "历史消息渲染"
		});
		const r = await session.evaluate(`
			return {
				total: document.querySelectorAll('.puzle-chat-message').length,
				user: document.querySelectorAll('.puzle-chat-message-user').length,
				assistant: document.querySelectorAll('.puzle-chat-message-assistant').length,
				hasThinking: !!document.querySelector('.puzle-chat-thinking'),
				firstUser: (document.querySelector('.puzle-chat-user-text')?.innerText || '').slice(0, 40)
			};
		`);
		console.log(`     消息 ${r.total} 条（用户 ${r.user} / 助手 ${r.assistant}），首条: ${r.firstUser}`);
		assert(r.user >= 1 && r.assistant >= 1, "历史消息角色不完整");
	});

	// ============ 写路径：会在账号产生真实数据 ============
	await test("写入：新会话发消息 → 流式 → 落库", async () => {
		await openChatPanel();
		await session.evaluate(`
			const btn = document.querySelector('.puzle-chat-new-button');
			if (btn) btn.click();
			return true;
		`);
		await sleep(500);

		const before = await inPlugin(`return p.getSocket().isConnected;`);
		console.log(`     发送前 WS 已连接: ${before}`);

		await typeAndSend("这是 Obsidian 插件联调测试。请分三点简述如何阅读一本书，每点两三句话。");

		await waitFor(session, `document.querySelectorAll('.puzle-chat-message-user').length >= 1`, {
			timeoutMs: 15000,
			label: "用户消息上屏"
		});
		await waitFor(session, `document.querySelector('.puzle-chat-stop') !== null`, {
			timeoutMs: 15000,
			label: "进入流式（停止按钮出现）"
		});
		console.log("     已进入流式…");

		// 流式增量：高频采样，确认是逐步累积渲染而非结束时一次性刷出
		const samples = [];
		for (let i = 0; i < 200; i++) {
			await sleep(300);
			samples.push((await assistantText()).length);
			const done = await session.evaluate(`return document.querySelector('.puzle-chat-send') !== null;`);
			if (done) break;
		}
		await waitFor(session, `document.querySelector('.puzle-chat-send') !== null`, {
			timeoutMs: 90000,
			label: "流式结束恢复发送按钮"
		});

		const text = await assistantText();
		const distinct = [...new Set(samples.filter((n) => n > 0))];
		const growth = samples.filter((n, i) => i > 0 && n > samples[i - 1]).length;
		console.log(`     长度采样: ${samples.filter((n) => n > 0).slice(0, 12).join("→")}…`);
		console.log(`     递增 ${growth} 次，出现 ${distinct.length} 个不同长度，最终 ${text.length} 字`);
		console.log(`     回复: ${text.slice(0, 90)}`);
		assert(text.length > 0, "assistant 回复为空");
		assert(growth >= 2, `未观察到真正的流式增量（递增仅 ${growth} 次，可能是一次性返回）`);
		assert(distinct.length >= 3, `渲染长度只出现 ${distinct.length} 种，疑似非增量渲染`);

		const state = await inPlugin(`
			const view = app.workspace.getLeavesOfType('puzle-chat-view')[0]?.view;
			const ctrl = view ? view.getController() : null;
			const st = ctrl?.getState();
			return { chatId: st?.active?.chatId ?? null, streaming: st?.active?.streaming, error: st?.active?.error ?? null };
		`);
		console.log(`     会话 id=${state.chatId} streaming=${state.streaming} error=${state.error}`);
		assert(state.chatId !== null, "新会话未回填 chat_id（ack 匹配失败）");
		assert(state.streaming === false, "流式状态未复位");
		assert(state.error === null, `结束时有错误: ${state.error}`);
		if (state.chatId) createdChats.push(state.chatId);
	});

	await test("写入：在既有会话追问（多轮上下文）", async () => {
		const chatId = createdChats[0];
		if (!chatId) throw new Error("前一个用例未产生会话，跳过");
		await openChatPanel();
		await typeAndSend("再用一句话确认你收到了。");
		await waitFor(session, `document.querySelector('.puzle-chat-stop') !== null`, {
			timeoutMs: 20000,
			label: "第二轮进入流式"
		});
		await waitFor(session, `document.querySelector('.puzle-chat-send') !== null`, {
			timeoutMs: 90000,
			label: "第二轮流式结束"
		});
		const r = await session.evaluate(`
			return {
				userMsgs: document.querySelectorAll('.puzle-chat-message-user').length,
				assistantMsgs: document.querySelectorAll('.puzle-chat-message-assistant').length,
				error: document.querySelector('.puzle-chat-error')?.innerText || null
			};
		`);
		console.log(`     用户 ${r.userMsgs} 条 / 助手 ${r.assistantMsgs} 条`);
		assert(r.userMsgs >= 2, "第二轮用户消息未累积");
		assert(r.assistantMsgs >= 2, "第二轮助手回复未累积");
		assert(!r.error, `出现错误: ${r.error}`);
	});

	await test("写入：流式中途停止（stop_completion）", async () => {
		await openChatPanel();
		await session.evaluate(`
			const btn = document.querySelector('.puzle-chat-new-button');
			if (btn) btn.click();
			return true;
		`);
		await sleep(500);
		await typeAndSend("请详细分点介绍如何阅读一本书的四个层次，每层至少写三百字，尽量展开。");
		await waitFor(session, `document.querySelector('.puzle-chat-stop') !== null`, {
			timeoutMs: 20000,
			label: "进入流式"
		});
		// 必须等到真的开始出字，否则「停止」测的是空转，验证不到截断
		await waitFor(
			session,
			`(() => {
				const n = [...document.querySelectorAll('.puzle-chat-message-assistant .puzle-chat-markdown')];
				return n.length > 0 && n[n.length-1].innerText.trim().length > 20;
			})()`,
			{ timeoutMs: 60000, label: "流式开始输出正文" }
		);
		const growthStart = (await assistantText()).length;
		await sleep(1500);
		const beforeStop = (await assistantText()).length;
		assert(beforeStop > growthStart, `停止前未观察到增长（${growthStart} → ${beforeStop}）`);

		await session.evaluate(`document.querySelector('.puzle-chat-stop').click(); return true;`);
		console.log(`     出字并增长后点停止（${growthStart} → ${beforeStop}）`);

		await waitFor(session, `document.querySelector('.puzle-chat-send') !== null`, {
			timeoutMs: 40000,
			label: "停止后恢复可发送"
		});
		const atStop = (await assistantText()).length;
		await sleep(5000);
		const afterStop = (await assistantText()).length;
		console.log(`     停止时长度 ${atStop}，等待 5s 后 ${afterStop}`);
		assert(afterStop === atStop, `停止后仍在增长: ${atStop} → ${afterStop}`);
		assert(afterStop > 0, "停止后已生成内容丢失");

		const state = await inPlugin(`
			const view = app.workspace.getLeavesOfType('puzle-chat-view')[0]?.view;
			const st = view?.getController?.()?.getState();
			return { streaming: st?.active?.streaming, chatId: st?.active?.chatId ?? null };
		`);
		assert(state.streaming === false, "停止后 streaming 未复位");
		if (state.chatId && !createdChats.includes(state.chatId)) createdChats.push(state.chatId);
	});

	await test("写入：AI 续写流式插入编辑器", async () => {
		await openNoteForEditing("联调-续写.md", "阅读可以分为四个层次，第一层是基础阅读，");
		const beforeLen = await session.evaluate(`return app.workspace.activeEditor.editor.getValue().length;`);

		await inPlugin(`app.commands.executeCommandById('puzle-read:puzle-continue-writing'); return true;`);
		await waitFor(session, `(() => {
			const el = document.querySelector('.status-bar-item.plugin-puzle-read');
			return !!el && el.style.display !== 'none';
		})()`, { timeoutMs: 20000, label: "续写状态栏出现" });
		console.log("     续写已启动…");

		await waitFor(
			session,
			`app.workspace.activeEditor.editor.getValue().length > ${beforeLen}`,
			{ timeoutMs: 60000, label: "续写内容开始写入" }
		);
		const samples = [];
		for (let i = 0; i < 30; i++) {
			await sleep(700);
			samples.push(await session.evaluate(`return app.workspace.activeEditor.editor.getValue().length;`));
			if (!(await writerRunning())) break;
		}
		await waitFor(session, `(() => {
			const el = document.querySelector('.status-bar-item.plugin-puzle-read');
			return !el || el.style.display === 'none';
		})()`, { timeoutMs: 90000, label: "续写结束状态栏隐藏" });

		const value = await session.evaluate(`return app.workspace.activeEditor.editor.getValue();`);
		const growth = samples.filter((n, i) => i > 0 && n > samples[i - 1]).length;
		console.log(`     长度采样: ${samples.slice(0, 8).join("→")}${samples.length > 8 ? "…" : ""}（递增 ${growth} 次）`);
		console.log(`     结果: ${value.slice(0, 120)}`);
		assert(value.startsWith("阅读可以分为四个层次，第一层是基础阅读，"), "原文被破坏");
		assert(value.length > beforeLen, "续写内容未写入");
		assert(growth >= 1, "未观察到流式增量写入");

		const chatId = await inPlugin(`return p.data.syncState.continuationChatId;`);
		console.log(`     续写会话 id 已持久化: ${chatId}`);
		assert(typeof chatId === "number", "continuationChatId 未持久化");
		if (chatId && !createdChats.includes(chatId)) createdChats.push(chatId);
	});

	await test("写入：续写期间编辑文档触发中止", async () => {
		await openNoteForEditing("联调-续写中断.md", "检视阅读的要点在于，");
		await inPlugin(`app.commands.executeCommandById('puzle-read:puzle-continue-writing'); return true;`);
		await waitFor(session, `(() => {
			const el = document.querySelector('.status-bar-item.plugin-puzle-read');
			return !!el && el.style.display !== 'none';
		})()`, { timeoutMs: 20000, label: "续写启动" });
		await waitFor(
			session,
			`app.workspace.activeEditor.editor.getValue().length > '检视阅读的要点在于，'.length`,
			{ timeoutMs: 60000, label: "首个片段写入" }
		);

		await session.evaluate(`
			const ed = app.workspace.activeEditor.editor;
			ed.replaceRange('【用户插入】', { line: 0, ch: 0 }, { line: 0, ch: 0 });
			return true;
		`);
		console.log("     已在插入点之前插入文字");

		await waitFor(session, `(() => {
			const el = document.querySelector('.status-bar-item.plugin-puzle-read');
			return !el || el.style.display === 'none';
		})()`, { timeoutMs: 30000, label: "检测到编辑后中止续写" });

		const afterAbort = await session.evaluate(`return app.workspace.activeEditor.editor.getValue();`);
		await sleep(4000);
		const final = await session.evaluate(`return app.workspace.activeEditor.editor.getValue();`);
		console.log(`     中止时: ${afterAbort.slice(0, 80)}`);
		assert(final === afterAbort, `中止后仍在写入:\n  ${afterAbort}\n  → ${final}`);
		assert(final.startsWith("【用户插入】"), "用户插入内容被破坏");
		assert(final.includes("检视阅读的要点在于，"), "原文被破坏");
	});

	// ============ 同步链路（写 vault，不写后端）============
	await test("同步：真实文章 + 高亮 + 对话全流程", async () => {
		try {
			await inPlugin(`
			const root = app.vault.getAbstractFileByPath('PuzleRead');
			if (root) await app.fileManager.trashFile(root);
			p.data.syncState = { lastSyncAt:null, articles:{}, highlights:{}, chats:{}, continuationChatId: p.data.syncState.continuationChatId };
			await p.saveSettings();
			const c = p.client;
			if (!c.__origIterate) c.__origIterate = c.iterateAllReadingItems.bind(c);
			// 放行 4 个会话：其中续写专用会话会被 ChatSyncer 有意跳过
			c.iterateAllReadingItems = async function* (filter) {
				let links = 0, chats = 0;
				for await (const item of c.__origIterate(filter)) {
					if (item.resource_type === 'chat') { if (chats++ < 4) yield item; }
					else { if (links++ < 3) yield item; }
					if (links >= 3 && chats >= 4) return;
				}
			};
			return true;
			`);
			await inPlugin(`app.commands.executeCommandById('puzle-read:puzle-full-sync'); return true;`);
			await waitFor(
			session,
			`app.vault.getFiles().filter(f=>f.path.startsWith('PuzleRead/Chats/')).length >= 2`,
			{ timeoutMs: 120000, label: "同步完成（含对话）" }
			);
			await sleep(2000);

			const r = await session.evaluate(`
			const files = app.vault.getFiles().map(f=>f.path).filter(x=>x.startsWith('PuzleRead'));
			const articles = files.filter(x=>x.includes('/Articles/'));
			const highlights = files.filter(x=>x.includes('/Highlights/'));
			const chats = files.filter(x=>x.includes('/Chats/'));
			const sample = articles[0] ? await app.vault.read(app.vault.getFileByPath(articles[0])) : '';
			return {
				articles: articles.length, highlights: highlights.length, chats: chats.length,
				hasBase: files.includes('PuzleRead/Articles.base'),
				sampleHasHtml: /<(div|p|h[1-6]|ul|li|table)\\b/.test(sample),
				sampleHasManaged: sample.includes('%% puzle:begin %%'),
				sampleHasFrontmatter: sample.startsWith('---')
			};
			`);
			console.log(`     文章 ${r.articles} / 高亮 ${r.highlights} / 对话 ${r.chats}`);
			assert(r.articles >= 3, "文章同步不足");
			assert(r.highlights > 0, "高亮未同步");
			assert(r.chats >= 2, "对话未同步");
			assert(r.hasBase, "Base 视图缺失");
			assert(r.sampleHasFrontmatter, "缺 frontmatter");
			assert(r.sampleHasManaged, "缺 managed 区");
			assert(!r.sampleHasHtml, "正文仍残留 HTML 标签（HTML→Markdown 未生效）");
		} finally {
			await restoreIterator();
		}
	});

	await test("设置：测试连接（真实鉴权）", async () => {
		await session.evaluate(`app.setting.open(); app.setting.openTabById('puzle-read'); return true;`);
		// Notice 渲染在设置 popout 窗口内，且 5s 后自动消失 —— 必须在那个窗口里高频轮询
		const settings = await connectToSettingsWindow();
		let seen = [];
		try {
			await waitFor(
				settings,
				`[...document.querySelectorAll('button')].some(b => b.textContent.includes('测试连接'))`,
				{ timeoutMs: 10000, label: "设置页渲染" }
			);
			await settings.evaluate(`
				[...document.querySelectorAll('button')].find(b => b.textContent.includes('测试连接')).click();
				return true;
			`);
			for (let i = 0; i < 80; i++) {
				const list = await settings.evaluate(
					`return [...document.querySelectorAll('.notice')].map(n => n.innerText);`
				);
				if (list.length) {
					seen = list;
					break;
				}
				await sleep(150);
			}
		} finally {
			settings.close();
		}
		console.log(`     ${seen.join(" | ")}`);
		assert(seen.some((n) => n.includes("连接成功")), `未出现连接成功提示，实际: ${JSON.stringify(seen)}`);
		assert(seen.some((n) => n.includes("卢书洋")), "未回显真实用户名");
		await session.evaluate(`app.setting.close(); return true;`);
	});

	session.close();

	console.log("\n" + "=".repeat(66));
	const passed = results.filter((r) => r.ok).length;
	for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n     ${r.error}`}`);
	console.log("=".repeat(66));
	console.log(`${passed}/${results.length} 通过`);
	if (createdChats.length) {
		console.log(`\n⚠️  本次在账号中创建了会话: ${[...new Set(createdChats)].join(", ")}`);
	}
	process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
	console.error("\n运行器异常:", err);
	session?.close();
	process.exit(2);
});
