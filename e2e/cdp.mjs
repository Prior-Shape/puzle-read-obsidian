// 通过 CDP 驱动 Obsidian（Electron/Chromium）的最小客户端。
// 依赖 Node 22 内置的全局 WebSocket，无需第三方模块。

const DEBUG_HOST = process.env.OBSIDIAN_CDP_HOST ?? "127.0.0.1:9222";

export async function findMainPage() {
	const res = await fetch(`http://${DEBUG_HOST}/json/list`);
	const targets = await res.json();
	const page = targets.find(
		(t) => t.type === "page" && String(t.url ?? "").startsWith("app://obsidian.md")
	);
	if (!page) throw new Error("未找到 Obsidian 主窗口 target，确认已用 --remote-debugging-port 启动");
	return page;
}

/** 列出所有 Obsidian 窗口及其 vault 路径。 */
export async function listVaultWindows() {
	const res = await fetch(`http://${DEBUG_HOST}/json/list`);
	const targets = await res.json();
	const pages = targets.filter(
		(t) => t.type === "page" && String(t.url ?? "").startsWith("app://obsidian.md")
	);
	const out = [];
	for (const page of pages) {
		let session;
		try {
			session = await CdpSession.attach(page.webSocketDebuggerUrl);
			await session.send("Runtime.enable");
			const info = await session.evaluate(
				`return { path: (typeof app!=='undefined' && app.vault?.adapter?.basePath) || null, name: (typeof app!=='undefined' && app.vault?.getName?.()) || null };`
			);
			out.push({ page, ...info });
		} catch {
			out.push({ page, path: null, name: null });
		} finally {
			session?.close();
		}
	}
	return out;
}

/**
 * Obsidian 1.13 起「设置」渲染在独立的 popout 窗口（target url 为 about:blank，
 * 标题以「设置」开头），主窗口里找不到设置 DOM。
 */
export async function connectToSettingsWindow({ timeoutMs = 8000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const res = await fetch(`http://${DEBUG_HOST}/json/list`);
		const targets = await res.json();
		const page = targets.find(
			(t) => t.type === "page" && /^设置|^Settings/.test(String(t.title ?? ""))
		);
		if (page) {
			const session = await CdpSession.attach(page.webSocketDebuggerUrl);
			await session.send("Runtime.enable");
			await session.send("Page.enable");
			return session;
		}
		if (Date.now() > deadline) throw new Error("未找到设置 popout 窗口");
		await sleep(200);
	}
}

/** 连接到 basePath 匹配的那个 vault 窗口（防止误操作到用户真实 vault）。 */
export async function connectToVault(vaultPath) {
	const windows = await listVaultWindows();
	const match = windows.find((w) => w.path === vaultPath);
	if (!match) {
		const seen = windows.map((w) => w.path ?? "(unknown)").join(", ");
		throw new Error(`未找到 vault 窗口: ${vaultPath}；当前打开的是: ${seen}`);
	}
	const session = await CdpSession.attach(match.page.webSocketDebuggerUrl);
	await session.send("Runtime.enable");
	await session.send("Page.enable");
	await session.send("Console.enable");
	// 二次确认，避免竞态下连错窗口
	const actual = await session.evaluate(`return app.vault.adapter.basePath;`);
	if (actual !== vaultPath) {
		session.close();
		throw new Error(`连接到了错误的 vault: ${actual}`);
	}
	return session;
}

export class CdpSession {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		this.eventListeners = new Map();
		ws.onmessage = (ev) => this.#handleMessage(String(ev.data));
	}

	static async attach(webSocketDebuggerUrl) {
		const ws = new WebSocket(webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			ws.onopen = resolve;
			ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
		});
		return new CdpSession(ws);
	}

	#handleMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.id !== undefined) {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			this.pending.delete(msg.id);
			if (msg.error) entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
			else entry.resolve(msg.result);
			return;
		}
		const listeners = this.eventListeners.get(msg.method);
		if (listeners) for (const fn of [...listeners]) fn(msg.params);
	}

	on(method, listener) {
		let set = this.eventListeners.get(method);
		if (!set) {
			set = new Set();
			this.eventListeners.set(method, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	}

	send(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP 调用超时: ${method}`));
				}
			}, 60000);
		});
	}

	/** 在页面上下文求值；表达式可以是 async，会自动 await。 */
	async evaluate(expression, { returnByValue = true } = {}) {
		const result = await this.send("Runtime.evaluate", {
			expression: `(async () => { ${expression} })()`,
			awaitPromise: true,
			returnByValue,
			allowUnsafeEvalBlocklistBypass: true
		});
		if (result.exceptionDetails) {
			const ex = result.exceptionDetails;
			const text = ex.exception?.description ?? ex.text ?? "unknown error";
			throw new Error(`页面内异常: ${text}`);
		}
		return result.result?.value;
	}

	async screenshot(path) {
		const { data } = await this.send("Page.captureScreenshot", { format: "png" });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, Buffer.from(data, "base64"));
		return path;
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
	}
}

export async function connect() {
	const page = await findMainPage();
	const session = await CdpSession.attach(page.webSocketDebuggerUrl);
	await session.send("Runtime.enable");
	await session.send("Page.enable");
	await session.send("Console.enable");
	return session;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 expression 求值为真，或超时抛错。 */
export async function waitFor(session, expression, { timeoutMs = 15000, intervalMs = 200, label = expression } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await session.evaluate(`return (${expression});`);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
		await sleep(intervalMs);
	}
}
