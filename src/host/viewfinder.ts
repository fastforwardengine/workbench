import { createHash } from 'node:crypto';
import type { Process, ProcessEvent, Workspace } from '@ambionframework/workspace';

/** The way that the workspace reads a running process. It is absent on a backend with no endpoints. */
type ReadProcess = NonNullable<Workspace['fetch']>;

/** What the viewfinder needs of the workspace. */
export type FinderWorkspace = Pick<Workspace, 'processes' | 'fetch'>;

/** The viewfinder reads a frame at this interval, in milliseconds. */
export const POLL_MS = 3_000;
/** A read ends after this time. A capture takes up to 30 s in the worst case and a few seconds in use. */
export const TIMEOUT_MS = 10_000;

/** The name of the process that the viewfinder follows. The camera template starts under this name. */
const CAMERA = 'camera';

/** The version of the sensor protocol that the viewfinder reads. */
const API = 2;

/** The form of the digest that names a file of a sensor server. */
const DIGEST = /^[0-9a-f]{64}$/;

const SEARCHING = 'Looking for the camera.';
export const NO_CAMERA = 'No camera is running. Ask the Engineer to start the camera.';
export const LOST =
	'The camera process ended. The viewfinder shows a frame again when a camera process starts.';
export const NO_ENDPOINTS = 'This workspace cannot read a process, so it has no camera.';

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
	/** The owner and the name of the process that the viewfinder reads, such as `engineer/camera`. */
	process: string | undefined;
	/** The latest frame. It stays while a later read fails. */
	frame: Frame | undefined;
	/** A line for the person: why there is no camera, or why the last read failed. */
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

/** The part of an observation that the viewfinder reads. */
interface Observation {
	readonly api?: unknown;
	readonly observations?: readonly {
		readonly at?: unknown;
		readonly parts?: readonly { readonly kind?: unknown; readonly file?: unknown }[];
	}[];
}

const labelOf = (process: Process): string => `${process.agent}/${process.name}`;

const isCamera = (process: Process): boolean => process.name === CAMERA;

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The reason that a sensor server gave for a status outside 200 to 299. */
async function refusal(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => undefined);
	const reason =
		typeof body === 'object' && body !== null && 'message' in body ? String(body.message) : '';
	return `The camera answered ${response.status}${reason ? `: ${reason}` : '.'}`;
}

/** Read GET `path` of the process `handle`, and fail on any answer but 2xx. */
async function read(
	fetchProcess: ReadProcess,
	handle: string,
	path: string,
	signal: AbortSignal,
): Promise<Response> {
	const response = await fetchProcess(handle, path, { signal });
	if (!response.ok) throw new Error(await refusal(response));
	return response;
}

/** The time and the digest of the newest frame of an observation, or an error that says what is wrong. */
function newestFrame(body: Observation): { at: string; digest: string } {
	if (body.api !== API)
		throw new Error(`The camera server does not speak protocol version ${API}.`);
	const sample = body.observations?.at(-1);
	const file = sample?.parts?.find((part) => part.kind === 'frame')?.file;
	if (typeof sample?.at !== 'string' || typeof file !== 'string' || !DIGEST.test(file))
		throw new Error('The camera returned no image.');
	return { at: sample.at, digest: file };
}

/**
 * Poll the camera process of the workspace, for display. A poll reads
 * `GET /camera/observe` and then `GET /files/<digest>` of the sensor
 * protocol, through `workspace.fetch`. The workspace keeps no snapshot of
 * it. One poll runs at a time, and it aborts when the viewfinder closes or
 * the process ends. The newest running process named `camera` is the one
 * that the viewfinder reads. `agents` names the owners that the viewfinder
 * lists at its start, so it finds a camera of an earlier run of the host.
 */
export function openViewfinder(
	workspace: FinderWorkspace,
	agents: readonly string[],
	changed: () => void,
	options: ViewfinderOptions = {},
): Viewfinder {
	return new Poller(workspace, agents, changed, options);
}

class Poller implements Viewfinder {
	private readonly workspace: FinderWorkspace;
	private readonly fetchProcess: ReadProcess | undefined;
	private readonly agents: readonly string[];
	private readonly changed: () => void;
	private readonly timeout: number;
	private readonly now: () => number;
	/** The running camera processes, the oldest first. */
	private running: Process[] = [];
	/** The process that the viewfinder reads. */
	private active: Process | undefined;
	private frame: Frame | undefined;
	private note: string | undefined = SEARCHING;
	/** The read in flight. Aborting it, or replacing it, drops its result. */
	private inflight: AbortController | undefined;
	private closed = false;
	/** True once the first list of processes has settled. Until then, an event only updates the list. */
	private seeded = false;
	private readonly unwatch: (() => void) | undefined;
	private readonly timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		workspace: FinderWorkspace,
		agents: readonly string[],
		changed: () => void,
		options: ViewfinderOptions,
	) {
		this.workspace = workspace;
		this.fetchProcess = workspace.fetch;
		this.agents = agents;
		this.changed = changed;
		this.timeout = options.timeout ?? TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		if (!this.fetchProcess) {
			this.note = NO_ENDPOINTS;
			return;
		}
		this.unwatch = workspace.processes.subscribe((event) => this.onEvent(event));
		this.timer = setInterval(() => void this.poll(), options.every ?? POLL_MS);
		// A forgotten viewfinder must not keep the process alive.
		this.timer.unref();
		void this.seed();
	}

	get state(): ViewfinderState {
		return {
			process: this.active && labelOf(this.active),
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

	/** Read the camera processes that run now. An event that arrived first is newer, so it stays last. */
	private async seed(): Promise<void> {
		const lists = await Promise.allSettled(
			this.agents.map((agent) => this.workspace.processes.list({ agent, running: true })),
		);
		if (this.closed) return;
		this.seeded = true;
		const found = lists
			.flatMap((list) => (list.status === 'fulfilled' ? list.value.filter(isCamera) : []))
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		const older = found.filter((one) => !this.running.some((known) => known.handle === one.handle));
		this.running = [...older, ...this.running];
		const rejected = lists.filter(
			(list): list is PromiseRejectedResult => list.status === 'rejected',
		);
		if (rejected[0] && rejected.length === lists.length) this.note = message(rejected[0].reason);
		this.choose();
	}

	private onEvent({ type, process }: ProcessEvent): void {
		if (this.closed) return;
		const others = this.running.filter((known) => known.handle !== process.handle);
		this.running = type === 'started' && isCamera(process) ? [...others, process] : others;
		if (this.seeded) this.choose();
	}

	/** Read the newest camera process. A change of process clears the frame. */
	private choose(): void {
		const next = this.running.at(-1);
		if (next?.handle === this.active?.handle && (next !== undefined || this.note !== SEARCHING))
			return;
		const lost = this.active !== undefined;
		this.cancel();
		this.active = next;
		this.frame = undefined;
		this.note = next ? undefined : lost ? LOST : NO_CAMERA;
		this.changed();
		void this.poll();
	}

	private cancel(): void {
		this.inflight?.abort();
		this.inflight = undefined;
	}

	private async poll(): Promise<void> {
		const process = this.active;
		if (this.closed || !process || this.inflight) return;
		const mine = new AbortController();
		this.inflight = mine;
		const timer = setTimeout(
			() => mine.abort(new Error('The camera did not answer in time.')),
			this.timeout,
		);
		try {
			this.accept(mine, await this.readFrame(process, mine.signal));
		} catch (error) {
			this.fail(mine, error);
		} finally {
			clearTimeout(timer);
			if (this.inflight === mine) this.inflight = undefined;
		}
	}

	/** One observation. A frame with the digest of the shown one needs no download. */
	private async readFrame(process: Process, signal: AbortSignal): Promise<Frame> {
		const fetchProcess = this.fetchProcess;
		if (!fetchProcess) throw new Error(NO_ENDPOINTS);
		const observed = await read(fetchProcess, process.handle, `/${CAMERA}/observe`, signal);
		const { at, digest } = newestFrame((await observed.json()) as Observation);
		const received = this.now();
		const shown = this.frame;
		if (shown?.digest === digest) return { ...shown, at, received };
		const file = await read(fetchProcess, process.handle, `/files/${digest}`, signal);
		const png = new Uint8Array(await file.arrayBuffer());
		if (createHash('sha256').update(png).digest('hex') !== digest)
			throw new Error('The camera frame does not match its digest.');
		return { at, digest, png, received };
	}

	private accept(mine: AbortController, frame: Frame): void {
		if (this.inflight !== mine || this.closed) return;
		this.frame = frame;
		this.note = undefined;
		this.changed();
	}

	private fail(mine: AbortController, error: unknown): void {
		if (this.inflight !== mine || this.closed) return;
		this.note = message(error);
		this.changed();
	}
}
