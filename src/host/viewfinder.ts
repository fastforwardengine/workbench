import type { SensorConnectionEvent, Workspace } from '@ambionframework/workspace';

/** The sensor registry of the workspace. It is absent when the workspace has no sensors. */
type Registry = NonNullable<Workspace['sensors']>;

/** The viewfinder reads a frame at this interval, in milliseconds. */
export const POLL_MS = 3_000;
/** A read ends after this time. A capture takes up to 30 s in the worst case and a few seconds in use. */
export const TIMEOUT_MS = 10_000;

/** The sensor name that the viewfinder shows. */
const SENSOR = 'camera';

const SEARCHING = 'Looking for the camera.';
export const NO_CAMERA = 'No camera is connected. Ask the Engineer to connect the camera.';
export const LOST =
	'The camera link ended. The viewfinder shows a frame again when the link returns.';
export const NO_SENSORS = 'This workspace has no sensors.';

/** One frame that a poll read. */
interface Frame {
	/** The time that the sensor gave the observation. */
	at: string;
	digest: string;
	png: Uint8Array;
	/** The time, in milliseconds, at which this process received the observation. */
	received: number;
}

/** What the viewfinder holds at one moment. */
export interface ViewfinderState {
	/** The qualified name of the sensor that the viewfinder reads, such as `bench/camera`. */
	sensor: string | undefined;
	/** The latest frame. It stays while a later read fails. */
	frame: Frame | undefined;
	/** A line for the person: why there is no sensor, or why the last read failed. */
	note: string | undefined;
}

/** A viewfinder that polls the camera. */
export interface Viewfinder {
	readonly state: ViewfinderState;
	/** Stop the poll, and abort a read in flight. */
	close(): void;
}

export interface ViewfinderOptions {
	/** The time between two polls, in milliseconds. */
	every?: number;
	/** The time after which a read ends, in milliseconds. */
	timeout?: number;
	/** The clock, in milliseconds. */
	now?: () => number;
}

const qualified = (connection: string): string => `${connection}/${SENSOR}`;

const hasCamera = (connection: { sensors: readonly { name: string }[] }): boolean =>
	connection.sensors.some((sensor) => sensor.name === SENSOR);

/**
 * Poll the camera sensor of the workspace, for display. A poll is an
 * `observe` through the sensor client of the registry. The workspace keeps no
 * snapshot of it. One poll runs at a time, and it aborts when the viewfinder
 * closes or the link ends. The newest connection that holds a `camera` sensor
 * is the one that the viewfinder reads.
 */
export function openViewfinder(
	registry: Registry | undefined,
	changed: () => void,
	options: ViewfinderOptions = {},
): Viewfinder {
	return new Poller(registry, changed, options);
}

class Poller implements Viewfinder {
	private readonly registry: Registry | undefined;
	private readonly changed: () => void;
	private readonly timeout: number;
	private readonly now: () => number;
	/** The connections that hold a camera, the oldest first. */
	private links: string[] = [];
	/** The connection that the viewfinder reads. */
	private active: string | undefined;
	private frame: Frame | undefined;
	private note: string | undefined = SEARCHING;
	/** The read in flight. Aborting it, or replacing it, drops its result. */
	private inflight: AbortController | undefined;
	private closed = false;
	private readonly unwatch: (() => void) | undefined;
	private readonly timer: ReturnType<typeof setInterval> | undefined;

	constructor(registry: Registry | undefined, changed: () => void, options: ViewfinderOptions) {
		this.registry = registry;
		this.changed = changed;
		this.timeout = options.timeout ?? TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		if (!registry) {
			this.note = NO_SENSORS;
			return;
		}
		this.unwatch = registry.subscribe((event) => this.onLink(event));
		this.timer = setInterval(() => void this.poll(), options.every ?? POLL_MS);
		void this.seed(registry);
	}

	get state(): ViewfinderState {
		return {
			sensor: this.active && qualified(this.active),
			frame: this.frame,
			note: this.note,
		};
	}

	close(): void {
		this.closed = true;
		this.unwatch?.();
		clearInterval(this.timer);
		this.cancel();
	}

	/** Read the links that exist now. An event that arrived first is newer, so it stays last. */
	private async seed(registry: Registry): Promise<void> {
		try {
			const listed = await registry.list();
			if (this.closed) return;
			const older = listed
				.filter((link) => link.state === 'connected' && hasCamera(link))
				.map((link) => link.name)
				.filter((name) => !this.links.includes(name));
			this.links = [...older, ...this.links];
		} catch (error) {
			if (this.closed) return;
			this.note = error instanceof Error ? error.message : String(error);
		}
		this.choose();
	}

	private onLink({ type, connection }: SensorConnectionEvent): void {
		if (this.closed) return;
		const up = type === 'connected' || type === 'refreshed';
		if (!up || !hasCamera(connection)) {
			this.drop(connection.name);
			return;
		}
		if (type === 'connected' || !this.links.includes(connection.name))
			this.links = [...this.links.filter((name) => name !== connection.name), connection.name];
		if (connection.name === this.active) this.restart();
		else this.choose();
	}

	private drop(name: string): void {
		this.links = this.links.filter((link) => link !== name);
		if (name === this.active) this.choose();
	}

	/** Read the newest connection. A change of connection clears the frame. */
	private choose(): void {
		const next = this.links.at(-1);
		if (next === this.active && (next !== undefined || this.note !== SEARCHING)) return;
		const lost = this.active !== undefined;
		this.cancel();
		this.active = next;
		this.frame = undefined;
		this.note = next ? undefined : lost ? LOST : NO_CAMERA;
		this.changed();
		void this.poll();
	}

	/** The same connection refreshed. Keep the frame and read again. */
	private restart(): void {
		this.cancel();
		this.note = undefined;
		this.changed();
		void this.poll();
	}

	private cancel(): void {
		this.inflight?.abort();
		this.inflight = undefined;
	}

	private async poll(): Promise<void> {
		const connection = this.active;
		if (this.closed || !connection || this.inflight) return;
		const mine = new AbortController();
		this.inflight = mine;
		const timer = setTimeout(
			() => mine.abort(new Error('The camera did not answer in time.')),
			this.timeout,
		);
		try {
			this.accept(mine, connection, await this.read(connection, mine.signal));
		} catch (error) {
			this.fail(mine, error);
		} finally {
			clearTimeout(timer);
			if (this.inflight === mine) this.inflight = undefined;
		}
	}

	/** One observation. A frame with the digest of the shown one needs no download. */
	private async read(connection: string, signal: AbortSignal): Promise<Frame | undefined> {
		const link = await this.registry?.get(qualified(connection), signal);
		if (!link) return undefined;
		const answer = await link.client.observe(SENSOR, { api: 1 }, signal);
		const sample = answer.observations.at(-1);
		const part = sample?.parts.find((candidate) => candidate.kind === 'frame');
		if (!sample || part?.kind !== 'frame') throw new Error('The camera returned no image.');
		const received = this.now();
		const shown = this.frame;
		if (shown?.digest === part.file) return { ...shown, at: sample.at, received };
		const file = await link.client.file(part.file, signal);
		return { at: sample.at, digest: part.file, png: file.bytes, received };
	}

	private accept(mine: AbortController, connection: string, frame: Frame | undefined): void {
		if (this.inflight !== mine || this.closed) return;
		if (!frame) {
			this.drop(connection);
			return;
		}
		this.frame = frame;
		this.note = undefined;
		this.changed();
	}

	private fail(mine: AbortController, error: unknown): void {
		if (this.inflight !== mine || this.closed) return;
		this.note = error instanceof Error ? error.message : String(error);
		this.changed();
	}
}
