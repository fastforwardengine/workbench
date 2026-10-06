import type { CameraView, Lab, Viewfinder, ViewfinderState } from '../../host/host.ts';
import { ActionPad } from './action-pad.ts';

type FinderHost = Pick<Lab, 'viewfinder' | 'actions' | 'act'>;

/** What the browser reads of the session: the open room, the person, and whether the room runs. */
export interface ViewSource {
	/** The name of the open room, or an empty string while no room is open. */
	room(): string;
	/** The person who presses an action, or undefined while nobody is chosen. */
	person(): string | undefined;
	/** True while the open room is stopped. */
	stopped(): boolean;
}

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
 * tick redraws the age of each frame between two polls. The pad holds the actions of the
 * shown cameras.
 */
export class ViewfinderBrowser {
	open = false;
	/** The actions of the shown cameras: the buttons under each box. */
	readonly pad: ActionPad;
	private finder: Viewfinder | undefined;
	/** The room that the viewfinder follows. */
	private following: string | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly host: FinderHost;
	private readonly source: ViewSource;
	private readonly changed: () => void;
	private readonly now: () => number;

	constructor(
		host: FinderHost,
		source: ViewSource,
		changed: () => void,
		now: () => number = Date.now,
	) {
		this.host = host;
		this.source = source;
		this.changed = changed;
		this.now = now;
		this.pad = new ActionPad({
			send: (person, act) => host.act(person, act),
			person: () => source.person(),
			stopped: () => source.stopped(),
			changed,
		});
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
		const room = this.source.room();
		if (this.open && drawable && room) this.start(room);
		else this.stop();
	}

	/** Read the actions of the shown cameras again. The pad leaves when no camera has an action. */
	syncActions(): void {
		const room = this.following;
		const names = new Set(this.state.cameras.map((camera) => camera.name));
		const widgets = room ? this.host.actions(room).filter((widget) => names.has(widget.name)) : [];
		this.pad.sync(widgets);
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
		this.pad.leave();
		this.following = undefined;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}
}
