import {
	App,
	EventRef,
	normalizePath,
	stringifyYaml,
	TFile,
	TFolder,
} from "obsidian";
import {
	findManagedRegion,
	hashManaged,
	upsertManagedRegion,
	wrapManaged,
} from "./managed";

const UNSAFE_FILE_NAME_CHARS = /[*"\\/<>:|?#^\[\]]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function sanitizeFileName(title: string): string {
	const cleaned = title
		.replace(UNSAFE_FILE_NAME_CHARS, "")
		.replace(CONTROL_CHARS, " ")
		.trim()
		.slice(0, 60)
		.trim();
	return cleaned.length > 0 ? cleaned : "untitled";
}

export class VaultGateway {
	constructor(
		readonly app: App,
		readonly rootFolder: string,
	) {}

	get root(): string {
		return normalizePath(this.rootFolder);
	}

	resolve(relativePath: string): string {
		return normalizePath(`${this.root}/${relativePath}`);
	}

	async ensureFolder(path: string): Promise<TFolder> {
		const parts = normalizePath(path).split("/").filter((p) => p.length > 0);
		if (parts.length === 0) {
			throw new Error(`Empty folder path: ${path}`);
		}
		let current = "";
		let folder: TFolder | null = null;
		for (const part of parts) {
			current = current.length > 0 ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing) {
				if (!(existing instanceof TFolder)) {
					throw new Error(`Path exists and is not a folder: ${current}`);
				}
				folder = existing;
				continue;
			}
			folder = await this.app.vault.createFolder(current);
		}
		return folder!;
	}

	async writeManaged(
		relativePath: string,
		frontmatterPatch: Record<string, unknown>,
		managedBody: string,
	): Promise<TFile> {
		const path = this.resolve(relativePath);
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent.length > 0) {
			await this.ensureFolder(parent);
		}

		const existing = this.app.vault.getFileByPath(path);
		if (!existing) {
			return await this.app.vault.create(
				path,
				buildNewFileContent(frontmatterPatch, managedBody),
			);
		}

		await this.app.fileManager.processFrontMatter(existing, (fm) => {
			for (const [key, value] of Object.entries(frontmatterPatch)) {
				fm[key] = value;
			}
		});
		await this.app.vault.process(existing, (data) =>
			upsertManagedRegion(data, managedBody),
		);
		return existing;
	}

	async readManagedHash(relativePath: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(this.resolve(relativePath));
		if (!file) return null;
		const content = await this.app.vault.cachedRead(file);
		const region = findManagedRegion(content);
		if (!region) return null;
		return hashManaged(region.inner);
	}

	async createFileIfNotExists(
		relativePath: string,
		content: string,
	): Promise<{ file: TFile; created: boolean }> {
		const path = this.resolve(relativePath);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) return { file: existing, created: false };
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent.length > 0) {
			await this.ensureFolder(parent);
		}
		const file = await this.app.vault.create(path, content);
		return { file, created: true };
	}

	registerRenameWatcher(
		callback: (oldPath: string, newPath: string) => void,
	): EventRef {
		return this.app.vault.on("rename", (file, oldPath) => {
			callback(oldPath, file.path);
		});
	}
}

function buildNewFileContent(
	frontmatterPatch: Record<string, unknown>,
	managedBody: string,
): string {
	const keys = Object.keys(frontmatterPatch);
	if (keys.length === 0) {
		return `${wrapManaged(managedBody)}\n`;
	}
	let frontmatter = stringifyYaml(frontmatterPatch);
	if (!frontmatter.endsWith("\n")) frontmatter += "\n";
	return `---\n${frontmatter}---\n\n${wrapManaged(managedBody)}\n`;
}
