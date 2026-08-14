import { hashManaged } from "../../src/vault/managed";
import type { VaultGateway } from "../../src/vault/gateway";

export interface FakeWrite {
	relative: string;
	frontmatter: Record<string, unknown>;
	managed: string;
	path: string;
}

export class FakeSyncGateway {
	readonly root: string;
	files = new Set<string>();
	managedByPath = new Map<string, string>();
	writes: FakeWrite[] = [];
	trashed: string[] = [];
	ensuredFolders: string[] = [];
	createdFiles: Array<{ path: string; content: string }> = [];
	writeShouldFail = false;

	constructor(root = "PuzleRead") {
		this.root = root;
	}

	resolve(relative: string): string {
		return `${this.root}/${relative}`;
	}

	async ensureFolder(path: string): Promise<{ path: string }> {
		this.ensuredFolders.push(path);
		this.files.add(path);
		return { path };
	}

	async writeManaged(
		relative: string,
		frontmatter: Record<string, unknown>,
		managed: string
	): Promise<{ path: string }> {
		if (this.writeShouldFail) throw new Error("write failed");
		const path = this.resolve(relative);
		this.writes.push({ relative, frontmatter, managed, path });
		this.files.add(path);
		this.managedByPath.set(path, managed);
		return { path };
	}

	async readManagedHash(relative: string): Promise<string | null> {
		const managed = this.managedByPath.get(this.resolve(relative));
		if (managed === undefined) return null;
		return hashManaged(managed.replace(/^\n+/, "").replace(/\n+$/, ""));
	}

	async createFileIfNotExists(
		relative: string,
		content: string
	): Promise<{ file: { path: string }; created: boolean }> {
		const path = this.resolve(relative);
		if (this.files.has(path)) return { file: { path }, created: false };
		this.files.add(path);
		this.createdFiles.push({ path, content });
		return { file: { path }, created: true };
	}

	get app(): {
		vault: {
			getAbstractFileByPath(path: string): { path: string } | null;
			getFileByPath(path: string): { path: string } | null;
		};
		fileManager: { trashFile(file: { path: string }): Promise<void> };
	} {
		return {
			vault: {
				getAbstractFileByPath: (path: string) =>
					this.files.has(path) ? { path } : null,
				getFileByPath: (path: string) => (this.files.has(path) ? { path } : null)
			},
			fileManager: {
				trashFile: async (file: { path: string }) => {
					this.trashed.push(file.path);
					this.files.delete(file.path);
					this.managedByPath.delete(file.path);
				}
			}
		};
	}

	asGateway(): VaultGateway {
		return this as unknown as VaultGateway;
	}
}
