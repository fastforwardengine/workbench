import type { Lab, Viewfinder, ViewfinderState } from '../../host/host.ts';

type FinderHost = Pick<Lab, 'viewfinder'>;

/** The age of the frame redraws at this interval, in milliseconds. */
export const TICK_MS = 1_000;

const EMPTY: ViewfinderState = { sensor: undefined, frame: undefined, note: undefined };

/** The time since a frame arrived, such as `2 s ago` or `3 min ago`. */
export function ageText(elapsed: number): string {
	const seconds = Math.max(0, Math.floor(elapsed / 1000));
	return seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ago`;
}

/**
 * The viewfinder panel, without drawing. The panel opens and closes. The
 * host polls the camera only while the panel is open and the terminal can
 * draw the frame. A tick redraws the age of the frame between two polls.
 */
export class ViewfinderBrowser {
	open = false;
	private finder: Viewfinder | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly host: FinderHost;
	private readonly changed: () => void;
	private readonly now: () => number;

	constructor(host: FinderHost, changed: () => void, now: () => number = Date.now) {
		this.host = host;
		this.changed = changed;
		this.now = now;
	}

	get state(): ViewfinderState {
		return this.finder?.state ?? EMPTY;
	}

	/** The age of the latest frame, or undefined while there is none. */
	get age(): string | undefined {
		const frame = this.state.frame;
		return frame ? ageText(this.now() - frame.received) : undefined;
	}

	show(): void {
		this.open = true;
	}

	/**
	 * Start the poll when the panel is open and `drawable` is true, and stop it
	 * otherwise. A call that changes nothing has no effect, so a draw may call it.
	 */
	watch(drawable: boolean): void {
		if (this.open && drawable) this.start();
		else this.stop();
	}

	hide(): void {
		this.open = false;
		this.stop();
		this.changed();
	}

	private start(): void {
		if (this.finder) return;
		this.finder = this.host.viewfinder(() => this.changed());
		this.ticker = setInterval(() => this.changed(), TICK_MS);
	}

	private stop(): void {
		this.finder?.close();
		this.finder = undefined;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}
}
