import type {
	PluginData,
	SyncArticleState,
	SyncChatState,
	SyncHighlightState,
	SyncState
} from "../settings";

export interface SyncStoreBackend {
	getData(): PluginData;
	saveData(): Promise<void>;
}

export class SyncStore {
	constructor(private readonly backend: SyncStoreBackend) {}

	private get state(): SyncState {
		return this.backend.getData().syncState;
	}

	get lastSyncAt(): string | null {
		return this.state.lastSyncAt;
	}

	setLastSyncAt(value: string | null): void {
		this.state.lastSyncAt = value;
	}

	get continuationChatId(): number | null {
		return this.state.continuationChatId;
	}

	setContinuationChatId(value: number | null): void {
		this.state.continuationChatId = value;
	}

	getArticle(id: number): SyncArticleState | undefined {
		return this.state.articles[id];
	}

	setArticle(id: number, value: SyncArticleState): void {
		this.state.articles[id] = value;
	}

	deleteArticle(id: number): void {
		delete this.state.articles[id];
	}

	articleEntries(): Array<[number, SyncArticleState]> {
		return Object.entries(this.state.articles).map(([key, value]) => [Number(key), value]);
	}

	getHighlight(id: number): SyncHighlightState | undefined {
		return this.state.highlights[id];
	}

	setHighlight(id: number, value: SyncHighlightState): void {
		this.state.highlights[id] = value;
	}

	deleteHighlight(id: number): void {
		delete this.state.highlights[id];
	}

	highlightEntries(): Array<[number, SyncHighlightState]> {
		return Object.entries(this.state.highlights).map(([key, value]) => [Number(key), value]);
	}

	getChat(id: number): SyncChatState | undefined {
		return this.state.chats[id];
	}

	setChat(id: number, value: SyncChatState): void {
		this.state.chats[id] = value;
	}

	deleteChat(id: number): void {
		delete this.state.chats[id];
	}

	chatEntries(): Array<[number, SyncChatState]> {
		return Object.entries(this.state.chats).map(([key, value]) => [Number(key), value]);
	}

	async flush(): Promise<void> {
		await this.backend.saveData();
	}

	handleRename(oldPath: string, newPath: string): boolean {
		if (oldPath === newPath) return false;
		let changed = false;
		const maps: Array<Record<string, { path: string }>> = [
			this.state.articles as unknown as Record<string, { path: string }>,
			this.state.highlights as unknown as Record<string, { path: string }>,
			this.state.chats as unknown as Record<string, { path: string }>
		];
		for (const map of maps) {
			for (const key of Object.keys(map)) {
				const entry = map[key];
				if (entry && entry.path === oldPath) {
					entry.path = newPath;
					changed = true;
				}
			}
		}
		return changed;
	}
}
