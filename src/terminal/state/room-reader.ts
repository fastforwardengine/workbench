import type { Message } from '@ambionframework/ambion';
import { coalesced } from './coalesce.ts';
import { type FeedSource, type FeedView, RoomFeed } from './feed.ts';

/** Where a reader reads a room and how it hears of a change. The Workbench host is one. */
export interface ReaderSource<View extends FeedView> extends FeedSource<View> {
	/** Call `changed` after each change of the room. The return value ends the watch. */
	watch(room: string, changed: () => void): () => void;
}

/**
 * The open room, read as often as it changes. It merges the messages of the
 * room, watches the room for changes, and reads the room again after each one.
 *
 * A change that lands during a read asks for one more read after the current
 * one, so no change is lost. A room view goes to `apply` inside the same
 * request, and an error of the read or of `apply` goes to `failed`.
 */
export class RoomReader<View extends FeedView> {
	private readonly source: ReaderSource<View>;
	private readonly feed: RoomFeed<View>;
	private readonly apply: (view: View) => Promise<void>;
	private readonly failed: (error: unknown) => void;
	/** The read of the open room. A change during a read asks for one more read. */
	private readonly readCoalesced = coalesced(() => this.readOnce());
	/** Ends the watch on the open room. The reader watches one room at a time. */
	private unwatch: (() => void) | undefined;

	constructor(
		source: ReaderSource<View>,
		apply: (view: View) => Promise<void>,
		failed: (error: unknown) => void,
	) {
		this.source = source;
		this.feed = new RoomFeed(source);
		this.apply = apply;
		this.failed = failed;
	}

	/** The messages read from the open room, in order. */
	get messages(): readonly Message[] {
		return this.feed.messages;
	}

	/** Point the reader at a room, and watch it. It drops the messages of the room it read before. */
	select(room: string): void {
		this.feed.select(room);
		this.unwatch?.();
		this.unwatch = this.source.watch(room, () => {
			void this.refresh();
		});
	}

	/** Stop watching. */
	stop(): void {
		this.unwatch?.();
		this.unwatch = undefined;
	}

	/**
	 * Read the open room. A watch calls this on each change. A call during a read
	 * asks for one more read after it.
	 */
	refresh(): Promise<void> {
		return this.readCoalesced();
	}

	private async readOnce(): Promise<void> {
		try {
			const view = await this.feed.refresh();
			if (view) await this.apply(view);
		} catch (error) {
			this.failed(error);
		}
	}
}
