const KEY = Symbol.for("pi-custom.side-conversations.v1");
export interface SideConversationRow {
	id: string;
	label: string;
	state: "running" | "idle";
	startedAt: number;
	updatedAt: number;
	parentId?: string;
}
interface Provider {
	snapshot(): SideConversationRow[];
	open(id: string): Promise<void>;
}
interface Registry {
	version: 1;
	owners: Map<string, Provider>;
}

/** A UI-only bridge: the fleet never receives transcripts or executable tools. */
export function registerSideConversations(
	ownerFile: string,
	provider: Provider,
): () => void {
	const root = globalThis as unknown as Record<symbol, unknown>;
	let registry = root[KEY] as Registry | undefined;
	if (registry === undefined)
		root[KEY] = registry = { version: 1, owners: new Map() };
	if (registry.version !== 1 || !(registry.owners instanceof Map))
		throw new Error("Unsupported side-conversation fleet registry");
	registry.owners.set(ownerFile, provider);
	return () => {
		if (registry.owners.get(ownerFile) === provider)
			registry.owners.delete(ownerFile);
	};
}
