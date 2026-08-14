import type { PuzleClient } from "./core/api/client";
import type { Logger } from "./core/ports";
import type { PuzleSocket } from "./core/ws/manager";
import type { PluginData, Settings } from "./settings";

export interface PluginDeps {
	logger: Logger;
	getSettings(): Settings;
	getData(): PluginData;
	getClient(): PuzleClient;
	getSocket(): PuzleSocket;
	saveData(): Promise<void>;
}
