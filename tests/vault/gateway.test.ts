import { App, parseYaml, stringifyYaml, TFile, TFolder } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { sanitizeFileName, VaultGateway } from "../../src/vault/gateway";
import { hashManaged, MANAGED_BEGIN_MARKER, MANAGED_END_MARKER } from "../../src/vault/managed";
import { scaffoldWorkspace } from "../../src/vault/scaffold";

type RenameListener = (file: TFile | TFolder, oldPath: string) => void;

class FakeVault {
	entries = new Map<string, TFile | TFolder>();
	contents = new Map<string, string>();
	renameListeners: RenameListener[] = [];
	createFolderCalls: string[] = [];

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		return this.entries.get(path) ?? null;
	}

	getFileByPath(path: string): TFile | null {
		const entry = this.entries.get(path);
		return entry instanceof TFile ? entry : null;
	}

	async createFolder(path: string): Promise<TFolder> {
		this.createFolderCalls.push(path);
		const folder = new TFolder();
		folder.path = path;
		this.entries.set(path, folder);
		return folder;
	}

	async create(path: string, data: string): Promise<TFile> {
		const file = new TFile();
		file.path = path;
		this.entries.set(path, file);
		this.contents.set(path, data);
		return file;
	}

	async read(file: TFile): Promise<string> {
		return this.contents.get(file.path) ?? "";
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const next = fn(this.contents.get(file.path) ?? "");
		this.contents.set(file.path, next);
		return next;
	}

	on(name: string, callback: RenameListener): object {
		if (name === "rename") this.renameListeners.push(callback);
		return {};
	}

	simulateRename(file: TFile | TFolder, newPath: string): void {
		const oldPath = file.path;
		this.entries.delete(oldPath);
		if (file instanceof TFile && this.contents.has(oldPath)) {
			this.contents.set(newPath, this.contents.get(oldPath) ?? "");
			this.contents.delete(oldPath);
		}
		file.path = newPath;
		this.entries.set(newPath, file);
		for (const listener of this.renameListeners) listener(file, oldPath);
	}
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function makeApp(vault: FakeVault): App {
	return {
		vault,
		fileManager: {
			async processFrontMatter(
				file: TFile,
				fn: (frontmatter: Record<string, unknown>) => void,
			): Promise<void> {
				const content = vault.contents.get(file.path) ?? "";
				const match = content.match(FRONTMATTER_RE);
				const frontmatter =
					(match ? parseYaml<Record<string, unknown>>(match[1]) : null) ?? {};
				fn(frontmatter);
				const rest = match ? content.slice(match[0].length) : content;
				const separator = rest.length === 0 || rest.startsWith("\n") ? "" : "\n";
				vault.contents.set(
					file.path,
					`---\n${stringifyYaml(frontmatter)}---\n${separator}${rest}`,
				);
			},
		},
	} as unknown as App;
}

describe("sanitizeFileName", () => {
	it("removes unsafe characters", () => {
		expect(sanitizeFileName('A*B"C\\D/E<F>G:H|I?J#K^L[M]N')).toBe("ABCDEFGHIJKLMN");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeFileName("  如何阅读一本书  ")).toBe("如何阅读一本书");
	});

	it("truncates to 60 characters", () => {
		expect(sanitizeFileName("x".repeat(80))).toHaveLength(60);
	});

	it("falls back for empty results", () => {
		expect(sanitizeFileName("***")).toBe("untitled");
		expect(sanitizeFileName("")).toBe("untitled");
	});
});

describe("VaultGateway", () => {
	let vault: FakeVault;
	let gateway: VaultGateway;

	beforeEach(() => {
		vault = new FakeVault();
		gateway = new VaultGateway(makeApp(vault), "PuzleRead");
	});

	describe("ensureFolder", () => {
		it("creates folders level by level", async () => {
			await gateway.ensureFolder("PuzleRead/Articles");
			expect(vault.createFolderCalls).toEqual(["PuzleRead", "PuzleRead/Articles"]);
			expect(vault.entries.get("PuzleRead")).toBeInstanceOf(TFolder);
			expect(vault.entries.get("PuzleRead/Articles")).toBeInstanceOf(TFolder);
		});

		it("is idempotent", async () => {
			await gateway.ensureFolder("PuzleRead/Articles");
			await gateway.ensureFolder("PuzleRead/Articles");
			expect(vault.createFolderCalls).toHaveLength(2);
		});

		it("throws when a path segment is a file", async () => {
			await vault.create("PuzleRead", "");
			await expect(gateway.ensureFolder("PuzleRead/Articles")).rejects.toThrow();
		});
	});

	describe("writeManaged", () => {
		it("creates a new file with frontmatter and a managed region", async () => {
			const file = await gateway.writeManaged(
				"Articles/如何阅读一本书 (r123).md",
				{ puzle_type: "article", reading_id: 123, title: "如何阅读一本书" },
				"## 摘要\n内容",
			);
			expect(file.path).toBe("PuzleRead/Articles/如何阅读一本书 (r123).md");
			expect(vault.entries.get("PuzleRead/Articles")).toBeInstanceOf(TFolder);

			const content = vault.contents.get(file.path)!;
			const match = content.match(FRONTMATTER_RE);
			expect(match).not.toBeNull();
			const frontmatter = parseYaml<Record<string, unknown>>(match![1]);
			expect(frontmatter).toEqual({
				puzle_type: "article",
				reading_id: 123,
				title: "如何阅读一本书",
			});
			expect(content).toContain(
				`${MANAGED_BEGIN_MARKER}\n## 摘要\n内容\n${MANAGED_END_MARKER}`,
			);
		});

		it("patches only given frontmatter keys and replaces only the managed region", async () => {
			const original = [
				"---",
				"puzle_type: article",
				"reading_id: 123",
				"user_key: 用户自己的字段",
				"---",
				"",
				"用户前言",
				"",
				MANAGED_BEGIN_MARKER,
				"旧的托管内容",
				MANAGED_END_MARKER,
				"",
				"用户笔记",
				"",
			].join("\n");
			const file = await vault.create("PuzleRead/Articles/a (r123).md", original);

			await gateway.writeManaged(
				"Articles/a (r123).md",
				{ synced: "2026-08-10T00:00:00Z" },
				"新的托管内容",
			);

			const content = vault.contents.get(file.path)!;
			const frontmatter = parseYaml<Record<string, unknown>>(
				content.match(FRONTMATTER_RE)![1],
			);
			expect(frontmatter.user_key).toBe("用户自己的字段");
			expect(frontmatter.puzle_type).toBe("article");
			expect(frontmatter.synced).toBe("2026-08-10T00:00:00Z");

			expect(content).toContain("用户前言");
			expect(content).toContain("用户笔记");
			expect(content).not.toContain("旧的托管内容");
			expect(content).toContain(
				`${MANAGED_BEGIN_MARKER}\n新的托管内容\n${MANAGED_END_MARKER}`,
			);
		});
	});

	describe("readManagedHash", () => {
		it("returns the hash of the managed region inner content", async () => {
			await vault.create(
				"PuzleRead/Articles/a.md",
				`前言\n${MANAGED_BEGIN_MARKER}\ninner\n${MANAGED_END_MARKER}\n后记`,
			);
			expect(await gateway.readManagedHash("Articles/a.md")).toBe(hashManaged("inner"));
		});

		it("returns null for missing files or missing regions", async () => {
			expect(await gateway.readManagedHash("Articles/nope.md")).toBeNull();
			await vault.create("PuzleRead/Articles/plain.md", "没有托管区");
			expect(await gateway.readManagedHash("Articles/plain.md")).toBeNull();
		});
	});

	describe("registerRenameWatcher", () => {
		it("reports old and new paths on rename", async () => {
			const events: Array<[string, string]> = [];
			const ref = gateway.registerRenameWatcher((oldPath, newPath) => {
				events.push([oldPath, newPath]);
			});
			expect(ref).toBeTruthy();

			const file = await vault.create("PuzleRead/Articles/a.md", "content");
			vault.simulateRename(file, "PuzleRead/Articles/b.md");

			expect(events).toEqual([
				["PuzleRead/Articles/a.md", "PuzleRead/Articles/b.md"],
			]);
		});
	});
});

describe("scaffoldWorkspace", () => {
	let vault: FakeVault;
	let gateway: VaultGateway;

	beforeEach(() => {
		vault = new FakeVault();
		gateway = new VaultGateway(makeApp(vault), "PuzleRead");
	});

	it("creates the folder structure, bases and README", async () => {
		const report = await scaffoldWorkspace(gateway);

		expect(report.createdFolders).toEqual([
			"PuzleRead",
			"PuzleRead/Articles",
			"PuzleRead/Highlights",
			"PuzleRead/Chats",
		]);
		expect(report.createdFiles).toEqual([
			"PuzleRead/Articles.base",
			"PuzleRead/Highlights.base",
			"PuzleRead/README.md",
		]);
		expect(report.skippedFiles).toEqual([]);

		const articlesBase = parseYaml<{ filters: { and: string[] } }>(
			vault.contents.get("PuzleRead/Articles.base")!,
		);
		expect(articlesBase.filters.and).toContain('file.inFolder("PuzleRead/Articles")');

		const readme = vault.contents.get("PuzleRead/README.md")!;
		expect(readme).toContain("Articles/");
		expect(readme).toContain("Highlights/");
		expect(readme).toContain("Chats/");
		expect(readme).toContain("Articles.base");
		expect(readme).toContain(MANAGED_BEGIN_MARKER);
	});

	it("never overwrites existing files and is idempotent", async () => {
		await vault.createFolder("PuzleRead");
		const customReadme = "# 用户自己的说明\n";
		await vault.create("PuzleRead/README.md", customReadme);

		const first = await scaffoldWorkspace(gateway);
		expect(first.skippedFiles).toEqual(["PuzleRead/README.md"]);
		expect(vault.contents.get("PuzleRead/README.md")).toBe(customReadme);

		const second = await scaffoldWorkspace(gateway);
		expect(second.createdFolders).toEqual([]);
		expect(second.createdFiles).toEqual([]);
		expect(second.skippedFiles).toEqual([
			"PuzleRead/Articles.base",
			"PuzleRead/Highlights.base",
			"PuzleRead/README.md",
		]);
		expect(vault.contents.get("PuzleRead/README.md")).toBe(customReadme);
	});
});
