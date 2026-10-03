/** The viewfinder poller of the host, over a fake sensor registry and fake timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	LOST,
	NO_CAMERA,
	NO_SENSORS,
	openViewfinder,
	POLL_MS,
	TIMEOUT_MS,
	type Viewfinder,
} from '../src/host/viewfinder.ts';

type Registry = Parameters<typeof openViewfinder>[0];
type Type = 'connected' | 'refreshed' | 'disconnected' | 'unavailable';

/** A sensor client. A test sets `frames` to choose what each observe returns. */
class FakeLink {
	frames: string[] = ['d1'];
	next = 0;
	/** While set, an observe waits for it, and ends when its signal aborts. */
	gate: Promise<void> | undefined;
	failure: string | undefined;
	readonly signals: AbortSignal[] = [];
	readonly observe = vi.fn(async (_name: string, _request: unknown, signal?: AbortSignal) => {
		if (signal) this.signals.push(signal);
		await this.waiting(signal);
		if (this.failure) throw new Error(this.failure);
		const digest = this.frames[Math.min(this.next++, this.frames.length - 1)];
		return {
			api: 1,
			observations: [
				{
					at: `2026-01-01T00:00:0${this.next}.000Z`,
					parts: [
						{ kind: 'text', text: 'label' },
						{ kind: 'frame', file: digest, mediaType: 'image/png' },
					],
				},
			],
		};
	});
	readonly file = vi.fn(async (digest: string) => ({ bytes: new TextEncoder().encode(digest) }));
	readonly client = { observe: this.observe, file: this.file };

	private waiting(signal?: AbortSignal): Promise<void> {
		if (!this.gate) return Promise.resolve();
		return new Promise((resolve, reject) => {
			void this.gate?.then(resolve);
			signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
		});
	}
}

/** A registry with the three calls that the viewfinder uses. */
class FakeRegistry {
	readonly listeners = new Set<(event: unknown) => void>();
	readonly links = new Map<string, FakeLink>();
	discovery: { name: string; state: string; sensors: { name: string }[] }[] = [];
	readonly get = vi.fn(async (sensor: string) => {
		const link = this.links.get(sensor);
		return link && { client: link.client, available: true };
	});
	readonly list = vi.fn(async () => this.discovery);
	readonly subscribe = (listener: (event: unknown) => void) => {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	};

	/** Add a connected link, with a camera, to the discovery that `list` returns. */
	connected(name: string, sensors = ['camera']): FakeLink {
		const link = new FakeLink();
		this.links.set(`${name}/camera`, link);
		this.discovery.push({
			name,
			state: 'connected',
			sensors: sensors.map((one) => ({ name: one })),
		});
		return link;
	}

	/** Report a change of a link, as the registry does after it commits one. */
	emit(type: Type, name: string, sensors = ['camera']): void {
		const connection = { name, state: type, sensors: sensors.map((one) => ({ name: one })) };
		for (const listener of [...this.listeners]) listener({ type, connection });
	}

	get as(): Registry {
		return this as unknown as Registry;
	}
}

const text = (png: Uint8Array | undefined) => new TextDecoder().decode(png);
const settle = () => vi.advanceTimersByTimeAsync(0);

const open: Viewfinder[] = [];
function watch(registry: FakeRegistry | undefined) {
	const changed = vi.fn();
	const finder = openViewfinder(registry?.as, changed);
	open.push(finder);
	return { finder, changed };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
	for (const finder of open.splice(0)) finder.close();
	vi.useRealTimers();
});

describe('the sensor that the viewfinder reads', () => {
	it('reads the connected camera at once, through the sensor client', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		const { finder, changed } = watch(registry);
		await settle();
		expect(finder.state.sensor).toBe('bench/camera');
		expect(text(finder.state.frame?.png)).toBe('d1');
		expect(finder.state.note).toBeUndefined();
		expect(link.observe).toHaveBeenCalledWith('camera', { api: 1 }, expect.any(AbortSignal));
		expect(registry.get).toHaveBeenCalledWith('bench/camera', expect.any(AbortSignal));
		expect(changed).toHaveBeenCalled();
	});

	it('tells the person to ask the Engineer when no camera is connected', async () => {
		const registry = new FakeRegistry();
		registry.connected('scope', ['probe']);
		const { finder } = watch(registry);
		await settle();
		expect(finder.state).toEqual({ sensor: undefined, frame: undefined, note: NO_CAMERA });
		expect(NO_CAMERA).toContain('Ask the Engineer');
	});

	it('says that the workspace has no sensors when it has no registry', () => {
		const { finder } = watch(undefined);
		expect(finder.state.note).toBe(NO_SENSORS);
	});

	it('picks up a camera that connects later', async () => {
		const registry = new FakeRegistry();
		const { finder } = watch(registry);
		await settle();
		registry.connected('bench');
		registry.emit('connected', 'bench');
		await settle();
		expect(finder.state.sensor).toBe('bench/camera');
		expect(text(finder.state.frame?.png)).toBe('d1');
	});

	it('ignores a connection that has no camera sensor', async () => {
		const registry = new FakeRegistry();
		const { finder } = watch(registry);
		await settle();
		registry.emit('connected', 'scope', ['probe']);
		await settle();
		expect(finder.state.note).toBe(NO_CAMERA);
	});

	it('reads the most recently connected camera, and returns to the older one when it ends', async () => {
		const registry = new FakeRegistry();
		registry.connected('old');
		const { finder } = watch(registry);
		await settle();
		expect(finder.state.sensor).toBe('old/camera');
		const newer = registry.connected('new');
		newer.frames = ['n1'];
		registry.emit('connected', 'new');
		expect(finder.state.frame).toBeUndefined();
		await settle();
		expect(finder.state.sensor).toBe('new/camera');
		expect(text(finder.state.frame?.png)).toBe('n1');
		registry.emit('disconnected', 'new');
		await settle();
		expect(finder.state.sensor).toBe('old/camera');
		expect(text(finder.state.frame?.png)).toBe('d1');
	});

	it('lets the newest of several listed cameras win', async () => {
		const registry = new FakeRegistry();
		registry.connected('first');
		registry.connected('second');
		const { finder } = watch(registry);
		await settle();
		expect(finder.state.sensor).toBe('second/camera');
	});
});

describe('the poll', () => {
	it('reads once every 3 seconds, and downloads a frame only when its digest changes', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		link.frames = ['d1', 'd1', 'd2'];
		const { finder } = watch(registry);
		await settle();
		const first = finder.state.frame?.received;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(link.observe).toHaveBeenCalledTimes(2);
		expect(link.file).toHaveBeenCalledTimes(1);
		expect(finder.state.frame?.digest).toBe('d1');
		expect(finder.state.frame?.received).toBe((first ?? 0) + POLL_MS);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(link.file).toHaveBeenCalledTimes(2);
		expect(text(finder.state.frame?.png)).toBe('d2');
	});

	it('runs one poll at a time', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		link.gate = new Promise(() => {});
		watch(registry);
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(link.observe).toHaveBeenCalledTimes(1);
	});

	it('ends a read that takes longer than the timeout, then reads again', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		link.gate = new Promise(() => {});
		const { finder } = watch(registry);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(finder.state.note).toContain('did not answer in time');
		link.gate = undefined;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(finder.state.note).toBeUndefined();
		expect(text(finder.state.frame?.png)).toBe('d1');
	});

	it('keeps the frame when a later read fails, and clears the note when one succeeds', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		const { finder } = watch(registry);
		await settle();
		link.failure = 'The camera capture failed.';
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(finder.state.note).toBe('The camera capture failed.');
		expect(text(finder.state.frame?.png)).toBe('d1');
		link.failure = undefined;
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(finder.state.note).toBeUndefined();
	});

	it('aborts the read in flight and stops polling when it closes', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		link.gate = new Promise(() => {});
		const { finder, changed } = watch(registry);
		await settle();
		const calls = changed.mock.calls.length;
		finder.close();
		expect(link.signals[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(link.observe).toHaveBeenCalledTimes(1);
		expect(changed.mock.calls.length).toBe(calls);
		expect(registry.listeners.size).toBe(0);
	});
});

describe('the timers', () => {
	it('leaves no timer after it closes, also with a read in flight', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		link.gate = new Promise(() => {});
		const { finder } = watch(registry);
		await settle();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		finder.close();
		await settle();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('the link events', () => {
	it('shows a plain line and stops reading when the only link disconnects', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		const { finder } = watch(registry);
		await settle();
		registry.emit('disconnected', 'bench');
		expect(finder.state).toEqual({ sensor: undefined, frame: undefined, note: LOST });
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(link.observe).toHaveBeenCalledTimes(1);
	});

	it('treats an unavailable link, such as an exited process, like a disconnect', async () => {
		const registry = new FakeRegistry();
		registry.connected('bench');
		const { finder } = watch(registry);
		await settle();
		registry.emit('unavailable', 'bench');
		expect(finder.state.note).toBe(LOST);
	});

	it('aborts the read in flight when the link disconnects', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		link.gate = new Promise(() => {});
		watch(registry);
		await settle();
		registry.emit('disconnected', 'bench');
		expect(link.signals[0]?.aborted).toBe(true);
	});

	it('reads again after a link returns', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		const { finder } = watch(registry);
		await settle();
		registry.emit('disconnected', 'bench');
		link.frames = ['d9'];
		link.next = 0;
		registry.emit('connected', 'bench');
		await settle();
		expect(text(finder.state.frame?.png)).toBe('d9');
	});

	it('keeps the frame on a refresh of the same link, and aborts the read in flight', async () => {
		const registry = new FakeRegistry();
		const link = registry.connected('bench');
		const { finder } = watch(registry);
		await settle();
		link.gate = new Promise(() => {});
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(link.signals).toHaveLength(2);
		registry.emit('refreshed', 'bench');
		expect(link.signals[1]?.aborted).toBe(true);
		expect(text(finder.state.frame?.png)).toBe('d1');
		await settle();
		expect(link.observe).toHaveBeenCalledTimes(3);
	});

	it('drops a link that the registry no longer finds', async () => {
		const registry = new FakeRegistry();
		registry.connected('bench');
		registry.links.clear();
		const { finder } = watch(registry);
		await settle();
		expect(finder.state.note).toBe(LOST);
	});
});
