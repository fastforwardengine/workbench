import type { CameraView, Lab, Viewfinder, ViewfinderState } from '../../host/host.ts';

type FinderHost = Pick<Lab, 'viewfinder'>;

/** The age of a frame redraws at this interval, in milliseconds. */
export const TICK_MS = 1_000;

const EMPTY: ViewfinderState = { cameras: [], note: undefined };

/** The time since a frame arrived, such as `2 s ago` or `3 min ago`. */
export function ageText(elapsed: number): string {
	const seconds = Math.max(0, Math.floor(elapsed / 1000));
	return seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ago`;
}

/**
 * The viewfinder panel, without drawing. The panel opens and closes. The
 * viewfinder follows the open room of the terminal: it reads the cameras that
 * the room shows, and it follows the person to another room. The host reads a
 * camera only while the panel is open and the terminal can draw the frame. A
 * tick redraws the age of each frame between two polls.
 */
export class ViewfinderBrowser {
	open = false;
	private finder: Viewfinder | undefined;
	/** The room that the viewfinder follows. */
	private following: string | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly host: FinderHost;
	private readonly room: () => string;
	private readonly changed: () => void;
	private readonly now: () => number;

	/** `room` gives the name of the open room, or an empty string while no room is open. */
	constructor(
		host: FinderHost,
		room: () => string,
		changed: () => void,
		now: () => number = Date.now,
	) {
		this.host = host;
		this.room = room;
		this.changed = changed;
		this.now = now;
	}

	get state(): ViewfinderState {
		return this.finder?.state ?? EMPTY;
	}

	/** The age of the latest frame of a camera, or undefined while it has none. */
	age(camera: CameraView): string | undefined {
		return camera.frame ? ageText(this.now() - camera.frame.received) : undefined;
	}

	show(): void {
		this.open = true;
	}

	/**
	 * Start the poll when the panel is open, a room is open, and `drawable` is true. Stop it
	 * otherwise. A change of the open room follows the new room. A call that changes nothing
	 * has no effect, so a draw may call it.
	 */
	watch(drawable: boolean): void {
		const room = this.room();
		if (this.open && drawable && room) this.start(room);
		else this.stop();
	}

	hide(): void {
		this.open = false;
		this.stop();
		this.changed();
	}

	private start(room: string): void {
		if (this.following === room) return;
		this.stop();
		// Record the room first: a viewfinder may call `changed`, and a draw calls `watch` again.
		this.following = room;
		this.finder = this.host.viewfinder(room, () => this.changed());
		this.ticker = setInterval(() => this.changed(), TICK_MS);
		this.ticker.unref();
	}

	private stop(): void {
		this.finder?.close();
		this.finder = undefined;
		this.following = undefined;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}
}
