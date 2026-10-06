import { createHash } from 'node:crypto';
import type { Canvas, CanvasEvent, CanvasWidget, WidgetKind } from '@ambionframework/canvas';
import type { ProcessEvent, Workspace } from '@ambionframework/workspace';

/** The way that the workspace reads a running process. It is absent on a backend with no endpoints. */
type ReadProcess = NonNullable<Workspace['fetch']>;

/** What the viewfinder needs of the workspace. */
export type FinderWorkspace = Pick<Workspace, 'processes' | 'fetch'>;

/** What the viewfinder needs of the canvas: the widgets of a room, and the events. */
export type FinderCanvas = Pick<Canvas, 'widgets' | 'subscribe'>;

/** The one widget kind of the host: the viewfinder frame of a camera process. One widget shows one camera. */
export const FRAME_KIND: WidgetKind = {
	name: 'frame',
	description: 'The newest frame that a camera process serves.',
	sources: ['process'],
	actions: false,
};

/** Each camera reads a frame at this interval, in milliseconds. */
export const POLL_MS = 3_000;
/** A read ends after this time. A capture takes up to 30 s in the worst case and a few seconds in use. */
export const TIMEOUT_MS = 10_000;
/** The most bytes of one observation. A larger body is a failed read. */
export const MAX_OBSERVATION_BYTES = 1024 * 1024;
/** The most bytes of one frame. A larger body is a failed read. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** The most widgets that the viewfinder binds. It ignores the others. */
export const MAX_BINDINGS = 4;

/** The version of the sensor protocol that the viewfinder reads. */
const API = 2;

/** The form of the digest that names a file of a sensor server. */
const DIGEST = /^[0-9a-f]{64}$/;

const STARTING = 'Reading the camera.';
export const NO_CAMERA = 'No camera is shown. Ask the Engineer to show the camera.';
export const NOT_RUNNING =
	'The camera process does not run. Ask the Engineer to show the camera again.';
export const LOST = 'The camera process ended. Ask the Engineer to show the camera again.';
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

/** One shown camera widget, as the terminal reads it. */
export interface CameraView {
	/** The name of the widget. The person says it: "hide bench". */
	name: string;
	/** The label of the widget for people, when the Engineer gave one. */
	title: string | undefined;
	/** The handle of the process that the viewfinder reads, while it reads one. */
	handle: string | undefined;
	/** The latest frame. It stays while a later read fails. */
	frame: Frame | undefined;
	/** A line for the person: why there is no frame, or why the last read failed. */
	note: string | undefined;
}

/** What the viewfinder holds at one moment. */
export interface ViewfinderState {
	/** One entry for each bound widget, in the order of binding. */
	cameras: readonly CameraView[];
	/** A line for the person about the whole viewfinder: no camera is shown, or a widget is ignored. */
	note: string | undefined;
}

/** A viewfinder over the camera widgets of one room. */
export interface Viewfinder {
	readonly state: ViewfinderState;
	/** Stop every poll, and abort each read in flight. */
	close(): void;
}

export interface ViewfinderOptions {
	/** The time between two polls of one camera, in milliseconds. */
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

/** The widget that a binding follows: a shown `frame` with a process source. */
interface Target {
	readonly name: string;
	readonly title: string | undefined;
	readonly author: string;
	readonly handle: string;
	readonly path: string;
}

/** What every binding shares. */
interface Context {
	readonly workspace: FinderWorkspace;
	readonly fetchProcess: ReadProcess;
	readonly every: number;
	readonly timeout: number;
	readonly now: () => number;
	readonly changed: () => void;
}

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

/** The body of a response, or a failure when it holds more than `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > limit) throw new Error(`The camera body of ${length} bytes is over ${limit}.`);
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
		total += part.value.byteLength;
		if (total > limit) {
			await reader?.cancel().catch(() => undefined);
			throw new Error(`The camera body is over ${limit} bytes.`);
		}
		chunks.push(part.value);
	}
	return Buffer.concat(chunks);
}

/** The time and the digest of the newest frame of an observation, or an error that says what is wrong. */
function newestFrame(bytes: Uint8Array): { at: string; digest: string } {
	let body: Observation;
	try {
		body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Observation;
	} catch {
		throw new Error('The camera returned no observation.');
	}
	if (body.api !== API)
		throw new Error(`The camera server does not speak protocol version ${API}.`);
	const sample = body.observations?.at(-1);
	const file = sample?.parts?.find((part) => part.kind === 'frame')?.file;
	if (typeof sample?.at !== 'string' || typeof file !== 'string' || !DIGEST.test(file))
		throw new Error('The camera returned no image.');
	return { at: sample.at, digest: file };
}

/**
 * The latest frame of the process `handle`. A frame with the digest of `previous` needs no
 * download. A downloaded frame must match its digest.
 */
async function readFrame(
	context: Context,
	handle: string,
	path: string,
	previous: Frame | undefined,
	signal: AbortSignal,
): Promise<Frame> {
	const { fetchProcess } = context;
	const observed = await read(fetchProcess, handle, path, signal);
	const { at, digest } = newestFrame(await readCapped(observed, MAX_OBSERVATION_BYTES));
	const received = context.now();
	if (previous?.digest === digest) return { ...previous, at, received };
	const file = await read(fetchProcess, handle, `/files/${digest}`, signal);
	const png = await readCapped(file, MAX_FRAME_BYTES);
	if (createHash('sha256').update(png).digest('hex') !== digest)
		throw new Error('The camera frame does not match its digest.');
	return { at, digest, png, received };
}

/** The shown `frame` widgets of a room with a process source, in the order of the canvas. */
function targetsOf(widgets: readonly CanvasWidget[]): Target[] {
	return widgets.flatMap((widget): Target[] =>
		widget.state === 'shown' && widget.kind === FRAME_KIND.name && widget.source?.type === 'process'
			? [
					{
						name: widget.name,
						title: widget.title,
						author: widget.author,
						handle: widget.source.handle,
						path: widget.source.path,
					},
				]
			: [],
	);
}

/** The targets to bind: the bound ones first, then the others, up to `MAX_BINDINGS`. */
function admit(wanted: readonly Target[], bound: ReadonlyMap<string, unknown>) {
	const ordered = [
		...wanted.filter((target) => bound.has(target.name)),
		...wanted.filter((target) => !bound.has(target.name)),
	];
	return { kept: ordered.slice(0, MAX_BINDINGS), ignored: ordered.slice(MAX_BINDINGS) };
}

/** Whether a canvas event is about the widgets of the room. */
function concerns(event: CanvasEvent, room: string): boolean {
	if (event.type === 'widget') return event.widget.room === room;
	return event.type === 'started' && event.room === room;
}

/** One widget bound to one process, with its own timer, read, and abort. */
class FrameBinding {
	private target: Target;
	private readonly context: Context;
	/** The process that the binding reads. It is set after the check of the author. */
	private handle: string | undefined;
	private frame: Frame | undefined;
	private note: string | undefined = STARTING;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** The read in flight. Aborting it, or replacing it, drops its result. */
	private inflight: AbortController | undefined;
	private closed = false;
	/** Whether the handle was checked against the processes of the author. */
	private checked = false;
	/** Whether the process of the handle ended. */
	private ended = false;

	constructor(context: Context, target: Target) {
		this.context = context;
		this.target = target;
	}

	get view(): CameraView {
		const { name, title } = this.target;
		return { name, title, handle: this.handle, frame: this.frame, note: this.note };
	}

	/** Take the widget as it is now. A moved source drops the old process. */
	retarget(next: Target): void {
		const moved =
			next.author !== this.target.author ||
			next.handle !== this.target.handle ||
			next.path !== this.target.path;
		const retitled = next.title !== this.target.title;
		this.target = next;
		if (moved) {
			this.checked = false;
			this.ended = false;
			this.clear(STARTING);
		} else if (retitled) this.context.changed();
	}

	/** Check once that the author runs the handle, then follow it. A failed list is tried again. */
	async verify(): Promise<void> {
		if (this.checked || this.closed) return;
		this.checked = true;
		const asked = this.target;
		const found = await this.runs(asked).catch(() => undefined);
		if (found === undefined) this.checked = false;
		if (found === undefined || this.closed || this.ended || asked.handle !== this.target.handle)
			return;
		if (found) this.follow();
		else this.clear(NOT_RUNNING);
	}

	/** The end of the bound process clears the frame. The binding waits for a new `show`. */
	observe(event: ProcessEvent): void {
		if (event.type !== 'ended' || event.process.handle !== this.target.handle) return;
		this.ended = true;
		this.clear(LOST);
	}

	close(): void {
		this.closed = true;
		this.clear(undefined, false);
	}

	/** Whether the author runs the process of the handle. */
	private async runs(asked: Target): Promise<boolean> {
		const running = await this.context.workspace.processes.list({
			agent: asked.author,
			running: true,
		});
		return running.some((process) => process.handle === asked.handle);
	}

	private follow(): void {
		if (this.handle === this.target.handle) return;
		this.handle = this.target.handle;
		this.note = STARTING;
		this.context.changed();
		this.timer = setInterval(() => void this.poll(), this.context.every);
		// A forgotten viewfinder must not keep the process alive.
		this.timer.unref();
		void this.poll();
	}

	/** Stop reading, drop the frame, and set the note. */
	private clear(note: string | undefined, notify = true): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.inflight?.abort();
		this.inflight = undefined;
		this.handle = undefined;
		this.frame = undefined;
		this.note = note;
		if (notify) this.context.changed();
	}

	private async poll(): Promise<void> {
		const handle = this.handle;
		if (this.closed || !handle || this.inflight) return;
		const mine = new AbortController();
		this.inflight = mine;
		const timer = setTimeout(
			() => mine.abort(new Error('The camera did not answer in time.')),
			this.context.timeout,
		);
		try {
			const frame = await readFrame(
				this.context,
				handle,
				this.target.path,
				this.frame,
				mine.signal,
			);
			this.settle(mine, frame, undefined);
		} catch (error) {
			this.settle(mine, undefined, message(error));
		} finally {
			clearTimeout(timer);
			if (this.inflight === mine) this.inflight = undefined;
		}
	}

	/** Keep the result of a read that is still current. A failure keeps the last frame. */
	private settle(mine: AbortController, frame: Frame | undefined, failure: string | undefined) {
		if (this.inflight !== mine || this.closed) return;
		if (frame) this.frame = frame;
		this.note = failure;
		this.context.changed();
	}
}

/**
 * Show the frames of the shown `frame` widgets of one room, one binding for each widget name,
 * and `MAX_BINDINGS` at most. A widget names the handle of a process of its author and a path.
 * A binding checks once that the author runs the handle, then polls the path of that process
 * by handle with `workspace.fetch`. A poll reads `GET <path>` and then `GET /files/<digest>`
 * of the sensor protocol. The workspace keeps no snapshot of it. One read of a camera runs at
 * a time, and it aborts when the viewfinder closes or the process ends.
 *
 * The viewfinder reads the widgets again on the `started` event of the room and on each
 * `widget` event. A `show` with another handle binds the new handle, and a `hide` removes the
 * binding. The `ended` event of a bound process clears the frame of its binding and touches no
 * other binding.
 */
export function openViewfinder(
	workspace: FinderWorkspace,
	canvas: FinderCanvas,
	room: string,
	changed: () => void,
	options: ViewfinderOptions = {},
): Viewfinder {
	return new Poller(workspace, canvas, room, changed, options);
}

class Poller implements Viewfinder {
	private readonly canvas: FinderCanvas;
	private readonly room: string;
	private readonly context: Context | undefined;
	private readonly bound = new Map<string, FrameBinding>();
	private ignored: readonly string[] = [];
	private closed = false;
	private readonly unsubscribe: (() => void)[] = [];

	constructor(
		workspace: FinderWorkspace,
		canvas: FinderCanvas,
		room: string,
		changed: () => void,
		options: ViewfinderOptions,
	) {
		this.canvas = canvas;
		this.room = room;
		const fetchProcess = workspace.fetch;
		if (!fetchProcess) return;
		this.context = {
			workspace,
			fetchProcess,
			every: options.every ?? POLL_MS,
			timeout: options.timeout ?? TIMEOUT_MS,
			now: options.now ?? Date.now,
			changed: () => {
				if (!this.closed) changed();
			},
		};
		this.unsubscribe.push(
			canvas.subscribe((event) => {
				if (concerns(event, room)) void this.bind();
			}),
			workspace.processes.subscribe((event) => {
				for (const binding of this.bound.values()) binding.observe(event);
			}),
		);
		// A constructor never calls `changed`: the caller has not stored the viewfinder yet.
		queueMicrotask(() => void this.bind());
	}

	get state(): ViewfinderState {
		return { cameras: [...this.bound.values()].map((binding) => binding.view), note: this.note };
	}

	/** The line about the whole viewfinder. */
	private get note(): string | undefined {
		if (!this.context) return NO_ENDPOINTS;
		if (this.bound.size === 0) return NO_CAMERA;
		return this.ignored.length > 0
			? `The viewfinder shows ${MAX_BINDINGS} cameras at most. Not shown: ${this.ignored.join(', ')}.`
			: undefined;
	}

	close(): void {
		this.closed = true;
		for (const stop of this.unsubscribe.splice(0)) stop();
		for (const binding of this.bound.values()) binding.close();
		this.bound.clear();
	}

	/** Note the ignored widgets. True when the note changes. */
	private noteIgnored(extra: readonly Target[]): boolean {
		const names = extra.map((target) => target.name);
		const same =
			names.length === this.ignored.length && names.every((n, i) => n === this.ignored[i]);
		this.ignored = names;
		return !same;
	}

	/** Close the bindings of widgets that are no longer wanted. True when one closes. */
	private drop(wanted: ReadonlySet<string>): boolean {
		const gone = [...this.bound.keys()].filter((name) => !wanted.has(name));
		for (const name of gone) {
			this.bound.get(name)?.close();
			this.bound.delete(name);
		}
		return gone.length > 0;
	}

	/** Read the widgets of the room, and bind the process handle that each frame widget names. */
	private async bind(): Promise<void> {
		const { context } = this;
		if (this.closed || !context) return;
		const { kept, ignored } = admit(targetsOf(this.canvas.widgets(this.room)), this.bound);
		const noted = this.noteIgnored(ignored);
		const dropped = this.drop(new Set(kept.map((target) => target.name)));
		const added = kept.filter((target) => !this.bound.has(target.name));
		for (const target of kept) {
			const binding = this.bound.get(target.name);
			if (binding) binding.retarget(target);
			else this.bound.set(target.name, new FrameBinding(context, target));
		}
		if (noted || dropped || added.length > 0) context.changed();
		await Promise.all([...this.bound.values()].map((binding) => binding.verify()));
	}
}
