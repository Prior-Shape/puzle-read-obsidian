export const MANAGED_BEGIN_MARKER = "%% puzle:begin %%";
export const MANAGED_END_MARKER = "%% puzle:end %%";

export interface ManagedRegion {
	start: number;
	end: number;
	inner: string;
	truncated: boolean;
}

export function findManagedRegion(content: string): ManagedRegion | null {
	const lines = content.split("\n");
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}

	let beginLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === MANAGED_BEGIN_MARKER) {
			beginLine = i;
			break;
		}
	}
	if (beginLine === -1) return null;

	let endLine = -1;
	for (let i = beginLine + 1; i < lines.length; i++) {
		if (lines[i].trim() === MANAGED_END_MARKER) {
			endLine = i;
			break;
		}
	}

	if (endLine === -1) {
		return {
			start: offsets[beginLine],
			end: content.length,
			inner: lines.slice(beginLine + 1).join("\n"),
			truncated: true,
		};
	}

	return {
		start: offsets[beginLine],
		end: offsets[endLine] + lines[endLine].length,
		inner: lines.slice(beginLine + 1, endLine).join("\n"),
		truncated: false,
	};
}

export function extractManagedInner(content: string): string | null {
	const region = findManagedRegion(content);
	return region ? region.inner : null;
}

export function wrapManaged(managedBody: string): string {
	const body = managedBody.replace(/^\n+/, "").replace(/\n+$/, "");
	if (body.length === 0) {
		return `${MANAGED_BEGIN_MARKER}\n${MANAGED_END_MARKER}`;
	}
	return `${MANAGED_BEGIN_MARKER}\n${body}\n${MANAGED_END_MARKER}`;
}

export function upsertManagedRegion(content: string, managedBody: string): string {
	const block = wrapManaged(managedBody);
	const region = findManagedRegion(content);

	if (!region) {
		const head = content.replace(/\s+$/, "");
		return `${head.length > 0 ? `${head}\n\n` : ""}${block}\n`;
	}

	const before = content.slice(0, region.start);
	const after = content.slice(region.end);
	if (after.length === 0) {
		return `${before}${block}\n`;
	}
	return `${before}${block}${after}`;
}

export function hashManaged(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
