/** The viewfinder poller of the host, over a fake workspace and fake timers. */
import { createHash } from 'node:crypto';
import type { Process, ProcessEvent } from '@ambionframework/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	LOST,
	NO_CAMERA,
	NO_ENDPOINTS,
	openViewfinder,
	POLL_MS,
	TIMEOUT_MS,
	type Viewfinder,
} from '../src/host/viewfinder.ts';

type Workspace = Parameters<typeof openViewfinder>[0];

/** The bytes of a frame named `label`, and the digest that names the file. */
const frameOf = (label: string) => {
	const bytes = new TextEncoder().encode(label);
	return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
};

const text = (png: Uint8Array | undefined) => new TextDecoder().decode(png);

/** An answer of a sensor server, with the parts of a `Response` that the viewfinder reads. */
const answer = (status: number, body: unknown, bytes?: Uint8Array) =>
	({
		ok: status >= 200 && status < 300,
		status,
		statusText: '',
		json: async () => body,
		arrayBuffer: async () => bytes?.buffer.slice(0) ?? new ArrayBuffer(0),
	}) as unknown as Response;

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
	readonly signals: AbortSignal[] = [];
	readonly paths: string[] = [];

	async answer(path: string, signal?: AbortSignal): Promise<Response> {
		this.paths.push(path);
		if (signal) this.signals.push(signal);
		await this.waiting(signal);
		if (this.failure)
			return answer(503, { api: this.api, code: 'unavailable', message: this.failure });
		if (path === '/camera/observe') return this.observe();
		const file = this.frames.map(frameOf).find((one) => path === `/files/${one.digest}`);
		if (!file) return answer(404, { api: this.api, code: 'unknown', message: 'Unknown path.' });
		return answer(200, undefined, this.corrupt ? new Uint8Array([1]) : file.bytes);
	}

	private observe(): Response {
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

const settle = () => vi.advanceTimersByTimeAsync(0);

const open: Viewfinder[] = [];
function watch(workspace: Workspace) {
	const changed = vi.fn();
	const finder = openViewfinder(workspace, ['engineer', 'researcher'], changed);
	open.push(finder);
	return { finder, changed };
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

describe('the process that the viewfinder reads', () => {
	it('reads the running camera at once, through workspace.fetch', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		const { finder, changed } = watch(workspace.as);
		await settle();
		expect(finder.state.process).toBe('engineer/camera');
		expect(text(finder.state.frame?.png)).toBe('d1');
		expect(finder.state.note).toBeUndefined();
		expect(camera.paths).toEqual(['/camera/observe', `/files/${frameOf('d1').digest}`]);
		expect(workspace.fetch).toHaveBeenCalledWith('bash-a', '/camera/observe', {
			signal: expect.any(AbortSignal),
		});
		expect(workspace.list).toHaveBeenCalledWith({ agent: 'engineer', running: true });
		expect(workspace.list).toHaveBeenCalledWith({ agent: 'researcher', running: true });
		expect(changed).toHaveBeenCalled();
	});

	it('tells the person to ask the Engineer when no camera runs', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a', 'engineer', 'scan');
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state).toEqual({ process: undefined, frame: undefined, note: NO_CAMERA });
		expect(NO_CAMERA).toContain('Ask the Engineer');
		expect(workspace.fetch).not.toHaveBeenCalled();
	});

	it('says that the workspace cannot read a process when it has no fetch', () => {
		const workspace = new FakeWorkspace();
		const { finder } = watch({ processes: workspace.processes } as unknown as Workspace);
		expect(finder.state.note).toBe(NO_ENDPOINTS);
		expect(workspace.listeners.size).toBe(0);
	});

	it('finds the camera of any specialist', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-r', 'researcher');
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.process).toBe('researcher/camera');
	});

	it('picks up a camera that starts later', async () => {
		const workspace = new FakeWorkspace();
		const { finder } = watch(workspace.as);
		await settle();
		workspace.running('bash-a');
		workspace.emit('started', 'bash-a');
		await settle();
		expect(finder.state.process).toBe('engineer/camera');
		expect(text(finder.state.frame?.png)).toBe('d1');
	});

	it('ignores a process with another name', async () => {
		const workspace = new FakeWorkspace();
		const { finder } = watch(workspace.as);
		await settle();
		workspace.running('bash-s', 'engineer', 'scan');
		workspace.emit('started', 'bash-s', 'scan');
		await settle();
		expect(finder.state.note).toBe(NO_CAMERA);
	});

	it('reads the newest camera, and returns to the older one when it ends', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-old');
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.process).toBe('engineer/camera');
		const newer = workspace.running('bash-new', 'researcher');
		newer.frames = ['n1'];
		workspace.emit('started', 'bash-new');
		expect(finder.state.frame).toBeUndefined();
		await settle();
		expect(finder.state.process).toBe('researcher/camera');
		expect(text(finder.state.frame?.png)).toBe('n1');
		workspace.emit('ended', 'bash-new');
		await settle();
		expect(finder.state.process).toBe('engineer/camera');
		expect(text(finder.state.frame?.png)).toBe('d1');
	});

	it('lets the newest of several listed cameras win', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-first');
		workspace.running('bash-second', 'researcher');
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.process).toBe('researcher/camera');
	});

	it('says why when every list fails', async () => {
		const workspace = new FakeWorkspace();
		workspace.failing = 'No such agent.';
		const { finder } = watch(workspace.as);
		await settle();
		expect(workspace.list).toHaveBeenCalledTimes(2);
		expect(finder.state.note).toBe('No such agent.');
	});

	it('reads on when one list fails and another works', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a', 'researcher');
		workspace.list.mockImplementationOnce(async () => {
			throw new Error('No such agent.');
		});
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.process).toBe('researcher/camera');
		expect(finder.state.note).toBeUndefined();
	});
});

describe('the poll', () => {
	it('reads once every 3 seconds, and downloads a frame only when its digest changes', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		camera.frames = ['d1', 'd1', 'd2'];
		const { finder } = watch(workspace.as);
		await settle();
		const first = finder.state.frame?.received;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(camera.paths.filter((path) => path === '/camera/observe')).toHaveLength(2);
		expect(camera.paths.filter((path) => path.startsWith('/files/'))).toHaveLength(1);
		expect(finder.state.frame?.digest).toBe(frameOf('d1').digest);
		expect(finder.state.frame?.received).toBe((first ?? 0) + POLL_MS);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(camera.paths.filter((path) => path.startsWith('/files/'))).toHaveLength(2);
		expect(text(finder.state.frame?.png)).toBe('d2');
	});

	it('runs one poll at a time', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		camera.gate = new Promise(() => {});
		watch(workspace.as);
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(camera.paths).toHaveLength(1);
	});

	it('ends a read that takes longer than the timeout, then reads again', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		camera.gate = new Promise(() => {});
		const { finder } = watch(workspace.as);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(finder.state.note).toContain('did not answer in time');
		camera.gate = undefined;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(finder.state.note).toBeUndefined();
		expect(text(finder.state.frame?.png)).toBe('d1');
	});

	it('keeps the frame when a later read fails, and clears the note when one succeeds', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		const { finder } = watch(workspace.as);
		await settle();
		camera.failure = 'The camera capture failed.';
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(finder.state.note).toBe('The camera answered 503: The camera capture failed.');
		expect(text(finder.state.frame?.png)).toBe('d1');
		camera.failure = undefined;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(finder.state.note).toBeUndefined();
	});

	it('shows a failed read of the process itself, such as a port that nobody listens on', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		workspace.fetch.mockRejectedValueOnce(
			new Error('Process bash-a does not listen on $PORT 20000.'),
		);
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.note).toBe('Process bash-a does not listen on $PORT 20000.');
		expect(finder.state.frame).toBeUndefined();
	});

	it('refuses a server that speaks another protocol version', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a').api = 1;
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.note).toContain('protocol version 2');
		expect(finder.state.frame).toBeUndefined();
	});

	it('refuses a frame whose bytes do not match its digest', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a').corrupt = true;
		const { finder } = watch(workspace.as);
		await settle();
		expect(finder.state.note).toContain('does not match its digest');
		expect(finder.state.frame).toBeUndefined();
	});

	it('aborts the read in flight and stops polling when it closes', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		camera.gate = new Promise(() => {});
		const { finder, changed } = watch(workspace.as);
		await settle();
		const calls = changed.mock.calls.length;
		finder.close();
		expect(camera.signals[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(camera.paths).toHaveLength(1);
		expect(changed.mock.calls.length).toBe(calls);
		expect(workspace.listeners.size).toBe(0);
	});
});

describe('the timers', () => {
	it('leaves no timer after it closes, also with a read in flight', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a').gate = new Promise(() => {});
		const { finder } = watch(workspace.as);
		await settle();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		finder.close();
		await settle();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('the process events', () => {
	it('shows a plain line and stops reading when the only camera ends', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		const { finder } = watch(workspace.as);
		await settle();
		workspace.emit('ended', 'bash-a');
		expect(finder.state).toEqual({ process: undefined, frame: undefined, note: LOST });
		const reads = camera.paths.length;
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(camera.paths).toHaveLength(reads);
	});

	it('aborts the read in flight when the camera ends', async () => {
		const workspace = new FakeWorkspace();
		const camera = workspace.running('bash-a');
		camera.gate = new Promise(() => {});
		watch(workspace.as);
		await settle();
		workspace.emit('ended', 'bash-a');
		expect(camera.signals[0]?.aborted).toBe(true);
	});

	it('reads again after a new camera starts', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		const { finder } = watch(workspace.as);
		await settle();
		workspace.emit('ended', 'bash-a');
		const next = workspace.running('bash-b');
		next.frames = ['d9'];
		workspace.emit('started', 'bash-b');
		await settle();
		expect(text(finder.state.frame?.png)).toBe('d9');
	});

	it('keeps the frame when another process starts or ends', async () => {
		const workspace = new FakeWorkspace();
		workspace.running('bash-a');
		const { finder } = watch(workspace.as);
		await settle();
		workspace.emit('started', 'bash-s', 'scan');
		workspace.emit('ended', 'bash-s', 'scan');
		expect(text(finder.state.frame?.png)).toBe('d1');
		expect(finder.state.process).toBe('engineer/camera');
	});
});
