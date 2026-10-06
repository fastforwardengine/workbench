/** The viewfinder of the host, over a fake workspace, a fake canvas, and fake timers. */
import { createHash } from 'node:crypto';
import type { CanvasEvent, CanvasWidget } from '@ambionframework/canvas';
import type { Process, ProcessEvent } from '@ambionframework/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	LOST,
	MAX_BINDINGS,
	MAX_FRAME_BYTES,
	MAX_OBSERVATION_BYTES,
	NO_CAMERA,
	NO_ENDPOINTS,
	NOT_RUNNING,
	openViewfinder,
	POLL_MS,
	TIMEOUT_MS,
	type Viewfinder,
} from '../src/host/viewfinder.ts';

type Workspace = Parameters<typeof openViewfinder>[0];
type Canvas = Parameters<typeof openViewfinder>[1];

const ROOM = 'build';

/** The bytes of a frame named `label`, and the digest that names the file. */
const frameOf = (label: string) => {
	const bytes = new TextEncoder().encode(label);
	return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
};

const text = (png: Uint8Array | undefined) => new TextDecoder().decode(png);

/** An answer of a sensor server: a real `Response`, as `workspace.fetch` gives. */
const answer = (
	status: number,
	body: unknown,
	bytes?: Uint8Array,
	headers?: Record<string, string>,
) => new Response(bytes ?? JSON.stringify(body), { status, headers });

/** A camera server. A test sets `frames` to choose what each observation names. */
class FakeCamera {
	frames: string[] = ['d1'];
	next = 0;
	api = 2;
	/** While set, a read waits for it, and ends when its signal aborts. */
	gate: Promise<void> | undefined;
	failure: string | undefined;
	/** The bytes that `/files/<digest>` returns in place of the real ones. */
	corrupt = false;
	/** The size that the observation body takes, in bytes, in place of its real one. */
	observationSize: number | undefined;
	/** The size that the file answer declares in `content-length`. */
	declaredSize: number | undefined;
	readonly signals: AbortSignal[] = [];
	readonly paths: string[] = [];

	async answer(path: string, signal?: AbortSignal): Promise<Response> {
		this.paths.push(path);
		if (signal) this.signals.push(signal);
		await this.waiting(signal);
		if (this.failure)
			return answer(503, { api: this.api, code: 'unavailable', message: this.failure });
		if (path.split('?')[0]?.endsWith('/observe')) return this.observe();
		const file = this.frames.map(frameOf).find((one) => path === `/files/${one.digest}`);
		if (!file) return answer(404, { api: this.api, code: 'unknown', message: 'Unknown path.' });
		const headers =
			this.declaredSize === undefined ? undefined : { 'content-length': String(this.declaredSize) };
		return answer(200, undefined, this.corrupt ? new Uint8Array([1]) : file.bytes, headers);
	}

	private observe(): Response {
		if (this.observationSize !== undefined)
			return answer(200, undefined, new Uint8Array(this.observationSize));
		const label = this.frames[Math.min(this.next++, this.frames.length - 1)] ?? '';
		return answer(200, {
			api: this.api,
			observations: [
				{
					at: `2026-01-01T00:00:0${this.next}.000Z`,
					parts: [
						{ kind: 'text', text: 'label' },
						{ kind: 'frame', file: frameOf(label).digest, mediaType: 'image/png' },
					],
				},
			],
		});
	}

	private waiting(signal?: AbortSignal): Promise<void> {
		if (!this.gate) return Promise.resolve();
		return new Promise((resolve, reject) => {
			void this.gate?.then(resolve);
			signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
		});
	}
}

let started = 0;
/** One running process, with a start time that grows with each call. */
const processOf = (handle: string, agent = 'engineer', name = 'camera'): Process => ({
	handle,
	name,
	kind: 'bash',
	agent,
	command: 'python3 camera.py',
	state: 'running',
	output: `/home/${agent}/.processes/${handle}/out`,
	timeout: 86400,
	grace: 10,
	port: 20000 + started,
	startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, started++)).toISOString(),
});

/** A workspace with the calls that the viewfinder uses: the process table, the events, and fetch. */
class FakeWorkspace {
	readonly listeners = new Set<(event: ProcessEvent) => void>();
	readonly table: Process[] = [];
	readonly cameras = new Map<string, FakeCamera>();
	failing: string | undefined;
	readonly list = vi.fn(async (query?: { agent?: string; running?: boolean }) => {
		if (this.failing) throw new Error(this.failing);
		return this.table.filter((one) => query?.agent === undefined || one.agent === query.agent);
	});
	readonly fetch = vi.fn(async (handle: string, path: string, init?: RequestInit) => {
		const camera = this.cameras.get(handle);
		if (!camera) throw new Error(`No running process is named '${handle}'.`);
		return camera.answer(path, init?.signal ?? undefined);
	});
	readonly processes = {
		list: this.list,
		subscribe: (listener: (event: ProcessEvent) => void) => {
			this.listeners.add(listener);
			return () => void this.listeners.delete(listener);
		},
	};

	/** Add a running process to the table that `list` reads, with a camera server behind it. */
	running(handle: string, agent = 'engineer', name = 'camera'): FakeCamera {
		const camera = new FakeCamera();
		this.cameras.set(handle, camera);
		this.table.push(processOf(handle, agent, name));
		return camera;
	}

	/** Report a start or an end, as the process table does after it commits one. */
	emit(type: ProcessEvent['type'], handle: string, name = 'camera'): void {
		const process =
			this.table.find((one) => one.handle === handle) ?? processOf(handle, 'engineer', name);
		for (const listener of [...this.listeners]) listener({ type, process });
	}

	get as(): Workspace {
		return this as unknown as Workspace;
	}
}

/** The widgets of the canvas for one room, with the events that the canvas emits. */
class FakeCanvas {
	readonly listeners = new Set<(event: CanvasEvent) => void>();
	readonly rows: CanvasWidget[] = [];
	readonly widgets = vi.fn((room: string) => this.rows.filter((one) => one.room === room));
	readonly subscribe = (listener: (event: CanvasEvent) => void) => {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	};
	private revisions = 0;

	/** Write a revision of a widget, as `show` or `hide` does, and report it. */
	write(widget: Partial<CanvasWidget> & { name: string }): CanvasWidget {
		const found = this.rows.findIndex(
			(one) => one.name === widget.name && one.room === (widget.room ?? ROOM),
		);
		const revision: CanvasWidget = {
			room: ROOM,
			revision: `r${++this.revisions}`,
			rev: this.revisions,
			state: 'shown',
			kind: 'frame',
			source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
			author: 'engineer',
			actions: [],
			...widget,
		};
		if (found >= 0) this.rows.splice(found, 1, revision);
		else this.rows.push(revision);
		this.emit({ type: 'widget', widget: revision });
		return revision;
	}

	/** Show a camera widget that names `handle`. */
	show(name: string, handle: string, more: Partial<CanvasWidget> = {}): CanvasWidget {
		return this.write({
			name,
			source: { type: 'process', handle, path: '/camera/observe' },
			...more,
		});
	}

	hide(name: string): void {
		this.write({ name, state: 'hidden' });
	}

	emit(event: CanvasEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	get as(): Canvas {
		return this as unknown as Canvas;
	}
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const open: Viewfinder[] = [];
function watch(workspace: Workspace, canvas: Canvas, room = ROOM) {
	const changed = vi.fn();
	const finder = openViewfinder(workspace, canvas, room, changed);
	open.push(finder);
	return { finder, changed };
}

/** The first camera of the state. */
function first(finder: Viewfinder) {
	const [camera] = finder.state.cameras;
	if (!camera) throw new Error('The viewfinder binds no camera.');
	return camera;
}

/** A workspace with one running camera, a canvas that shows it as `bench`, and a viewfinder. */
function benchSetup() {
	const workspace = new FakeWorkspace();
	const camera = workspace.running('bash-a');
	const canvas = new FakeCanvas();
	canvas.show('bench', 'bash-a', { title: 'Bench camera' });
	return { workspace, camera, canvas, ...watch(workspace.as, canvas.as) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	started = 0;
});

afterEach(() => {
	for (const finder of open.splice(0)) finder.close();
	vi.useRealTimers();
});

describe('the widgets that the viewfinder binds', () => {
	it('reads the process of a shown frame widget by handle, through workspace.fetch', async () => {
		const { workspace, camera, canvas, finder, changed } = benchSetup();
		await settle();
		expect(finder.state.cameras).toHaveLength(1);
		const bench = first(finder);
		expect(bench).toMatchObject({ name: 'bench', title: 'Bench camera', handle: 'bash-a' });
		expect(text(bench.frame?.png)).toBe('d1');
		expect(bench.note).toBeUndefined();
		expect(finder.state.note).toBeUndefined();
		expect(camera.paths).toEqual(['/camera/observe', `/files/${frameOf('d1').digest}`]);
		expect(workspace.fetch).toHaveBeenCalledWith('bash-a', '/camera/observe', {
			signal: expect.any(AbortSignal),
		});
		expect(canvas.widgets).toHaveBeenCalledWith(ROOM);
		expect(changed).toHaveBeenCalled();
	});

	it('reads the path that the widget names', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		const canvas = new FakeCanvas();
		canvas.write({
			name: 'bench',
			source: { type: 'process', handle: 'bash-a', path: '/camera/observe?width=640' },
		});
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(camera.paths[0]).toBe('/camera/observe?width=640');
		expect(text(first(finder).frame?.png)).toBe('d1');
	});

	it('tells the person to ask the Engineer when the room shows no camera', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		const { finder } = watch(workspace.as, new FakeCanvas().as);
		await settle();
		expect(finder.state).toEqual({ cameras: [], note: NO_CAMERA });
		expect(NO_CAMERA).toContain('Ask the Engineer to show the camera');
		expect(workspace.fetch).not.toHaveBeenCalled();
	});

	it('binds the process by handle, whatever its name', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-s', 'engineer', 'scan');
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-s');
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(text(first(finder).frame?.png)).toBe('d1');
	});

	it('says that the workspace cannot read a process when it has no fetch', () => {
		const workspace = new FakeWorkspace();
		const canvas = new FakeCanvas();
		const { finder } = watch({ processes: workspace.processes } as unknown as Workspace, canvas.as);
		expect(finder.state).toEqual({ cameras: [], note: NO_ENDPOINTS });
		expect(workspace.listeners.size).toBe(0);
		expect(canvas.listeners.size).toBe(0);
	});

	it('ignores a hidden widget, another kind, another source, and another room', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		const canvas = new FakeCanvas();
		canvas.show('gone', 'bash-a', { state: 'hidden' });
		canvas.show('table', 'bash-a', { kind: 'table' });
		canvas.write({ name: 'file', source: { type: 'file', path: '/shared/kit.md' } });
		canvas.show('elsewhere', 'bash-a', { room: 'other' });
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(finder.state).toEqual({ cameras: [], note: NO_CAMERA });
		expect(workspace.fetch).not.toHaveBeenCalled();
	});

	it('binds a camera that a show adds later, on the widget event of the room', async () => {
		const workspace = new FakeWorkspace();
		const canvas = new FakeCanvas();
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(finder.state.note).toBe(NO_CAMERA);
		workspace.running('bash-a');
		canvas.show('bench', 'bash-a');
		await settle();
		expect(first(finder).name).toBe('bench');
		expect(text(first(finder).frame?.png)).toBe('d1');
		expect(finder.state.note).toBeUndefined();
	});

	it('ignores the widget event of another room', async () => {
		const workspace = new FakeWorkspace();
		const canvas = new FakeCanvas();
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		workspace.running('bash-a');
		canvas.show('bench', 'bash-a', { room: 'other' });
		await settle();
		expect(finder.state.cameras).toEqual([]);
		expect(canvas.widgets).toHaveBeenCalledTimes(1);
	});

	it('reads the widgets again when the room starts', async () => {
		const workspace = new FakeWorkspace();
		const canvas = new FakeCanvas();
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		workspace.running('bash-a');
		canvas.rows.push({
			room: ROOM,
			name: 'bench',
			revision: 'r9',
			rev: 1,
			state: 'shown',
			kind: 'frame',
			source: { type: 'process', handle: 'bash-a', path: '/camera/observe' },
			author: 'engineer',
			actions: [],
		});
		canvas.emit({ type: 'started', room: 'other' });
		await settle();
		expect(finder.state.cameras).toEqual([]);
		canvas.emit({ type: 'started', room: ROOM });
		await settle();
		expect(text(first(finder).frame?.png)).toBe('d1');
	});

	it('removes the binding of a hidden widget, and aborts its read', async () => {
		const { camera, canvas, finder } = benchSetup();
		camera.gate = new Promise(() => {});
		await settle();
		canvas.hide('bench');
		await settle();
		expect(finder.state).toEqual({ cameras: [], note: NO_CAMERA });
		expect(camera.signals[0]?.aborted).toBe(true);
		const reads = camera.paths.length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(camera.paths).toHaveLength(reads);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('binds a hidden widget again after a new show, with a fresh check of its process', async () => {
		const { workspace, canvas, finder } = benchSetup();
		await settle();
		canvas.hide('bench');
		canvas.show('bench', 'bash-a');
		await settle();
		expect(text(first(finder).frame?.png)).toBe('d1');
		expect(workspace.list).toHaveBeenCalledTimes(2);
	});

	it('reads the new process when a show names another handle, and drops the old frame', async () => {
		const { workspace, canvas, finder } = benchSetup();
		await settle();
		const next = workspace.running('bash-b');
		next.frames = ['n1'];
		canvas.show('bench', 'bash-b');
		expect(first(finder).frame).toBeUndefined();
		await settle();
		expect(first(finder).handle).toBe('bash-b');
		expect(text(first(finder).frame?.png)).toBe('n1');
		expect(workspace.cameras.get('bash-a')?.signals.every((signal) => !signal.aborted)).toBe(true);
	});

	it('keeps the binding on a new title, and reads nothing again', async () => {
		const { workspace, camera, canvas, finder, changed } = benchSetup();
		await settle();
		const reads = camera.paths.length;
		const calls = changed.mock.calls.length;
		canvas.show('bench', 'bash-a', { title: 'Shelf' });
		await settle();
		expect(first(finder).title).toBe('Shelf');
		expect(camera.paths).toHaveLength(reads);
		expect(changed.mock.calls.length).toBeGreaterThan(calls);
		expect(workspace.list).toHaveBeenCalledTimes(1);
	});

	it('binds several cameras at once, each with its own process', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a').frames = ['a1'];
		workspace.running('bash-b').frames = ['b1'];
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-a');
		canvas.show('shelf', 'bash-b');
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(finder.state.cameras.map((one) => [one.name, text(one.frame?.png)])).toEqual([
			['bench', 'a1'],
			['shelf', 'b1'],
		]);
	});
});

describe('the constructor', () => {
	it('calls changed on no path before it returns', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-a');
		const { finder, changed } = watch(workspace.as, canvas.as);
		expect(changed).not.toHaveBeenCalled();
		expect(finder.state.cameras).toEqual([]);
		await settle();
		expect(changed).toHaveBeenCalled();
		expect(first(finder).name).toBe('bench');
	});
});

describe('the events that change the actions', () => {
	it('draws again on a new revision of the same widget, and on an answer', async () => {
		const { canvas, changed } = benchSetup();
		await settle();
		const calls = changed.mock.calls.length;
		canvas.show('bench', 'bash-a', { title: 'Bench camera', for: 'priya' });
		await settle();
		expect(changed.mock.calls.length).toBeGreaterThan(calls);
		const after = changed.mock.calls.length;
		canvas.emit({ type: 'answered', room: ROOM, revision: 'r1', seq: 4 });
		await settle();
		expect(changed.mock.calls.length).toBeGreaterThan(after);
		const last = changed.mock.calls.length;
		canvas.emit({ type: 'answered', room: 'other', revision: 'r1', seq: 4 });
		await settle();
		expect(changed.mock.calls.length).toBe(last);
	});
});

describe('the check of the author', () => {
	it('lists the running processes of the author of the widget', async () => {
		const { workspace } = benchSetup();
		await settle();
		expect(workspace.list).toHaveBeenCalledWith({ agent: 'engineer', running: true });
	});

	it('reads no handle that the author does not run', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-r', 'researcher');
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-r', { author: 'engineer' });
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(workspace.fetch).not.toHaveBeenCalled();
		expect(first(finder)).toMatchObject({ handle: undefined, frame: undefined, note: NOT_RUNNING });
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(workspace.fetch).not.toHaveBeenCalled();
	});

	it('reads no handle that no process holds', async () => {
		const workspace = new FakeWorkspace();
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-missing');
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(workspace.fetch).not.toHaveBeenCalled();
		expect(first(finder).note).toBe(NOT_RUNNING);
	});

	it('checks once for a widget, however many events follow', async () => {
		const { workspace, canvas } = benchSetup();
		await settle();
		canvas.emit({ type: 'started', room: ROOM });
		canvas.write({ name: 'other', source: { type: 'file', path: '/x' } });
		await settle();
		expect(workspace.list).toHaveBeenCalledTimes(1);
	});

	it('checks again after a failed list', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		workspace.failing = 'No such agent.';
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-a');
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(workspace.fetch).not.toHaveBeenCalled();
		workspace.failing = undefined;
		canvas.emit({ type: 'started', room: ROOM });
		await settle();
		expect(text(first(finder).frame?.png)).toBe('d1');
	});
});

describe('the limit of bindings', () => {
	function crowd(count: number) {
		const workspace = new FakeWorkspace();
		const canvas = new FakeCanvas();
		for (let index = 0; index < count; index++) {
			workspace.running(`bash-${index}`);
			canvas.show(`cam${index}`, `bash-${index}`);
		}
		return { workspace, canvas, ...watch(workspace.as, canvas.as) };
	}

	it('binds four widgets at most, and names the others in the note', async () => {
		const { workspace, finder } = crowd(6);
		await settle();
		expect(MAX_BINDINGS).toBe(4);
		expect(finder.state.cameras.map((one) => one.name)).toEqual(['cam0', 'cam1', 'cam2', 'cam3']);
		expect(finder.state.note).toBe(
			'The viewfinder shows 4 cameras at most. Not shown: cam4, cam5.',
		);
		expect(workspace.fetch.mock.calls.some(([handle]) => handle === 'bash-4')).toBe(false);
		expect(workspace.list).toHaveBeenCalledTimes(4);
	});

	it('binds an ignored widget when a hide frees a place', async () => {
		const { canvas, finder } = crowd(5);
		await settle();
		expect(finder.state.cameras).toHaveLength(4);
		canvas.hide('cam1');
		await settle();
		expect(finder.state.cameras.map((one) => one.name)).toEqual(['cam0', 'cam2', 'cam3', 'cam4']);
		expect(finder.state.note).toBeUndefined();
	});

	it('keeps the bound widgets when a new one comes first in the canvas', async () => {
		const { workspace, canvas, finder } = crowd(4);
		await settle();
		workspace.running('bash-new');
		canvas.rows.unshift({ ...canvas.rows[0], name: 'early', revision: 'rx' } as CanvasWidget);
		canvas.show('early', 'bash-new');
		await settle();
		expect(finder.state.cameras.map((one) => one.name)).toEqual(['cam0', 'cam1', 'cam2', 'cam3']);
		expect(finder.state.note).toContain('Not shown: early');
	});
});

describe('the poll', () => {
	it('reads once every 3 seconds, and downloads a frame only when its digest changes', async () => {
		const { camera, finder } = benchSetup();
		camera.frames = ['d1', 'd1', 'd2'];
		await settle();
		const received = first(finder).frame?.received;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(camera.paths.filter((path) => path === '/camera/observe')).toHaveLength(2);
		expect(camera.paths.filter((path) => path.startsWith('/files/'))).toHaveLength(1);
		expect(first(finder).frame?.digest).toBe(frameOf('d1').digest);
		expect(first(finder).frame?.received).toBe((received ?? 0) + POLL_MS);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(camera.paths.filter((path) => path.startsWith('/files/'))).toHaveLength(2);
		expect(text(first(finder).frame?.png)).toBe('d2');
	});

	it('runs one poll at a time', async () => {
		const { camera } = benchSetup();
		camera.gate = new Promise(() => {});
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(camera.paths).toHaveLength(1);
	});

	it('ends a read that takes longer than the timeout, then reads again', async () => {
		const { camera, finder } = benchSetup();
		camera.gate = new Promise(() => {});
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(first(finder).note).toContain('did not answer in time');
		camera.gate = undefined;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(first(finder).note).toBeUndefined();
		expect(text(first(finder).frame?.png)).toBe('d1');
	});

	it('keeps the frame when a later read fails, and clears the note when one succeeds', async () => {
		const { camera, finder } = benchSetup();
		await settle();
		camera.failure = 'The camera capture failed.';
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(first(finder).note).toBe('The camera answered 503: The camera capture failed.');
		expect(text(first(finder).frame?.png)).toBe('d1');
		camera.failure = undefined;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(first(finder).note).toBeUndefined();
	});

	it('shows a failed read of the process itself, such as a port that nobody listens on', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		workspace.fetch.mockRejectedValueOnce(
			new Error('Process bash-a does not listen on $PORT 20000.'),
		);
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-a');
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		expect(first(finder).note).toBe('Process bash-a does not listen on $PORT 20000.');
		expect(first(finder).frame).toBeUndefined();
	});

	it('refuses a server that speaks another protocol version', async () => {
		const { camera, finder } = benchSetup();
		camera.api = 1;
		await settle();
		expect(first(finder).note).toContain('protocol version 2');
		expect(first(finder).frame).toBeUndefined();
	});

	it('refuses a frame whose bytes do not match its digest', async () => {
		const { camera, finder } = benchSetup();
		camera.corrupt = true;
		await settle();
		expect(first(finder).note).toContain('does not match its digest');
		expect(first(finder).frame).toBeUndefined();
	});

	it('refuses an observation over 1 MiB', async () => {
		const { camera, finder } = benchSetup();
		camera.observationSize = MAX_OBSERVATION_BYTES + 1;
		await settle();
		expect(first(finder).note).toContain(`over ${MAX_OBSERVATION_BYTES} bytes`);
		expect(first(finder).frame).toBeUndefined();
		expect(camera.paths).toEqual(['/camera/observe']);
	});

	it('refuses a frame over 16 MiB from its declared size, before it reads the body', async () => {
		const { camera, finder } = benchSetup();
		camera.declaredSize = MAX_FRAME_BYTES + 1;
		await settle();
		expect(first(finder).note).toContain(`is over ${MAX_FRAME_BYTES}`);
		expect(first(finder).frame).toBeUndefined();
	});

	it('aborts the read in flight and stops polling when it closes', async () => {
		const { camera, finder, changed } = benchSetup();
		camera.gate = new Promise(() => {});
		await settle();
		const calls = changed.mock.calls.length;
		finder.close();
		expect(camera.signals[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(camera.paths).toHaveLength(1);
		expect(changed.mock.calls.length).toBe(calls);
	});
});

describe('the timers and the subscriptions', () => {
	it('leaves no timer and no listener after it closes, also with a read in flight', async () => {
		const { workspace, camera, canvas, finder } = benchSetup();
		camera.gate = new Promise(() => {});
		await settle();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		finder.close();
		await settle();
		expect(vi.getTimerCount()).toBe(0);
		expect(workspace.listeners.size).toBe(0);
		expect(canvas.listeners.size).toBe(0);
	});

	it('binds nothing after it closes', async () => {
		const { workspace, canvas, finder } = benchSetup();
		await settle();
		finder.close();
		workspace.running('bash-b');
		canvas.show('shelf', 'bash-b');
		await settle();
		expect(finder.state.cameras).toEqual([]);
		expect(workspace.cameras.get('bash-b')?.paths).toEqual([]);
	});
});

describe('the process events', () => {
	it('clears the frame of the binding when its process ends, and says so', async () => {
		const { workspace, camera, finder } = benchSetup();
		await settle();
		workspace.emit('ended', 'bash-a');
		expect(first(finder)).toMatchObject({ handle: undefined, frame: undefined, note: LOST });
		expect(LOST).toContain('ended');
		const reads = camera.paths.length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(camera.paths).toHaveLength(reads);
	});

	it('clears only the binding of the process that ended', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a').frames = ['a1'];
		workspace.running('bash-b').frames = ['b1'];
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-a');
		canvas.show('shelf', 'bash-b');
		const { finder } = watch(workspace.as, canvas.as);
		await settle();
		workspace.emit('ended', 'bash-a');
		const [bench, shelf] = finder.state.cameras;
		expect(bench).toMatchObject({ name: 'bench', frame: undefined, note: LOST });
		expect(shelf).toMatchObject({ name: 'shelf', handle: 'bash-b' });
		expect(text(shelf?.frame?.png)).toBe('b1');
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(workspace.cameras.get('bash-b')?.paths.length).toBeGreaterThan(2);
	});

	it('aborts the read in flight when the process ends', async () => {
		const { workspace, camera } = benchSetup();
		camera.gate = new Promise(() => {});
		await settle();
		workspace.emit('ended', 'bash-a');
		expect(camera.signals[0]?.aborted).toBe(true);
	});

	it('keeps the binding after the end, so the widget draws nothing until a new show', async () => {
		const { workspace, canvas, finder } = benchSetup();
		await settle();
		workspace.emit('ended', 'bash-a');
		canvas.emit({ type: 'started', room: ROOM });
		await settle();
		expect(first(finder)).toMatchObject({ frame: undefined, note: LOST });
	});

	it('reads again after a show that names the new process', async () => {
		const { workspace, canvas, finder } = benchSetup();
		await settle();
		workspace.emit('ended', 'bash-a');
		const next = workspace.running('bash-b');
		next.frames = ['d9'];
		canvas.show('bench', 'bash-b');
		await settle();
		expect(first(finder)).toMatchObject({ handle: 'bash-b', note: undefined });
		expect(text(first(finder).frame?.png)).toBe('d9');
	});

	it('keeps the frame when another process starts or ends', async () => {
		const { workspace, finder } = benchSetup();
		await settle();
		workspace.emit('started', 'bash-s', 'scan');
		workspace.emit('ended', 'bash-s', 'scan');
		expect(text(first(finder).frame?.png)).toBe('d1');
		expect(first(finder).handle).toBe('bash-a');
	});

	it('does not follow a process that ended before the check finished', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		const canvas = new FakeCanvas();
		canvas.show('bench', 'bash-a');
		const { finder } = watch(workspace.as, canvas.as);
		// The binding exists after the first microtask. The list then waits for the end.
		await Promise.resolve();
		workspace.emit('ended', 'bash-a');
		await settle();
		expect(workspace.fetch).not.toHaveBeenCalled();
		expect(first(finder)).toMatchObject({ handle: undefined, note: LOST });
	});
});
