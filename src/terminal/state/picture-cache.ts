import type { FileContent } from '../../host/files.ts';
import { type Strip, stripOf } from './pictures.ts';

/** How many refs the cache keeps, with the refs that hold no picture. */
const MAX_REFS = 64;
/** The most picture bytes that the cache keeps. */
const MAX_BYTES = 64 * 1_048_576;

/** A loaded ref: its strip, or `null` when it holds no picture or did not load. */
type Slot = Strip | null;

const bytesOf = (slot: Slot): number =>
	slot?.pictures.reduce((sum, picture) => sum + picture.data.byteLength, 0) ?? 0;

/**
 * The pictures of snapshot refs, loaded in the background. A snapshot ref
 * names fixed bytes, so one load per ref is enough. The cache keeps the most
 * recent refs within a bound on the count and on the bytes, and it never
 * drops a ref that the screen shows. A ref that fails to load stays empty,
 * and the cache does not retry it.
 */
export class PictureCache {
	private readonly slots = new Map<string, Slot>();
	private readonly loading = new Set<string>();
	private shown = new Set<string>();
	private readonly load: (ref: string) => Promise<FileContent>;
	private readonly changed: () => void;

	constructor(load: (ref: string) => Promise<FileContent>, changed: () => void) {
		this.load = load;
		this.changed = changed;
	}

	/** The strip of a ref, once loaded. A read makes the ref the most recent. */
	get(ref: string): Strip | undefined {
		const slot = this.slots.get(ref);
		if (slot === undefined) return undefined;
		this.slots.delete(ref);
		this.slots.set(ref, slot);
		return slot ?? undefined;
	}

	/** Start the load of every shown ref that the cache does not hold. */
	want(refs: readonly string[]): void {
		this.shown = new Set(refs);
		for (const ref of this.shown)
			if (!this.slots.has(ref) && !this.loading.has(ref)) void this.read(ref);
	}

	get size(): number {
		return this.slots.size;
	}

	private async read(ref: string): Promise<void> {
		this.loading.add(ref);
		let slot: Slot = null;
		try {
			slot = stripOf(ref, await this.load(ref)) ?? null;
		} catch {
			// A ref that does not load has no thumbnail. The chip stays.
		}
		this.loading.delete(ref);
		this.slots.set(ref, slot);
		this.trim();
		if (slot) this.changed();
	}

	/** Drop the oldest refs that the screen does not show, until the bounds hold. */
	private trim(): void {
		let bytes = 0;
		for (const slot of this.slots.values()) bytes += bytesOf(slot);
		for (const [ref, slot] of this.slots) {
			if (this.slots.size <= MAX_REFS && bytes <= MAX_BYTES) return;
			if (this.shown.has(ref)) continue;
			this.slots.delete(ref);
			bytes -= bytesOf(slot);
		}
	}
}
