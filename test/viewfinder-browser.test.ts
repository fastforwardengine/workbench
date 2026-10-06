/** The state of the viewfinder panel, and the session command that opens it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraView } from '../src/host/host.ts';
import { ageText, TICK_MS, ViewfinderBrowser } from '../src/terminal/state/viewfinder-browser.ts';
import { FakeHost, started } from './fake-host.ts';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

const frame = (received: number) => ({
	at: '2026-01-01T00:00:00Z',
	digest: 'd1',
	png: new Uint8Array([1]),
	received,
});

const bench = (received: number): CameraView => ({
	name: 'bench',
	title: 'Bench camera',
	handle: 'bash-a',
	frame: frame(received),
	note: undefined,
});

/** A browser over a fake host. `room` is the open room, and a test may change it. */
function browserOf(host: FakeHost, changed = vi.fn(), now?: () => number) {
	const open = { room: 'build' };
	const browser = new ViewfinderBrowser(host, () => open.room, changed, now);
	return { browser, open, changed };
}

describe('the age of a frame', () => {
	it('counts seconds, then minutes', () => {
		expect(ageText(-5)).toBe('0 s ago');
		expect(ageText(2_400)).toBe('2 s ago');
		expect(ageText(59_999)).toBe('59 s ago');
		expect(ageText(60_000)).toBe('1 min ago');
		expect(ageText(185_000)).toBe('3 min ago');
	});
});

describe('the viewfinder browser', () => {
	it('opens without a poll, and starts it when the terminal can draw the frame', () => {
		const host = new FakeHost();
		const { browser } = browserOf(host);
		browser.show();
		expect(browser.open).toBe(true);
		expect(host.finders).toHaveLength(0);
		browser.watch(false);
		expect(host.finders).toHaveLength(0);
		browser.watch(true);
		browser.watch(true);
		expect(host.finders).toHaveLength(1);
	});

	it('does not poll a panel that is closed', () => {
		const host = new FakeHost();
		browserOf(host).browser.watch(true);
		expect(host.finders).toHaveLength(0);
	});

	it('follows the open room, and no poll starts while no room is open', () => {
		const host = new FakeHost();
		const { browser, open } = browserOf(host);
		open.room = '';
		browser.show();
		browser.watch(true);
		expect(host.finders).toHaveLength(0);
		open.room = 'build';
		browser.watch(true);
		expect(host.finders.map((finder) => finder.room)).toEqual(['build']);
	});

	it('follows the person to another room: it closes the old viewfinder and opens a new one', () => {
		const host = new FakeHost();
		const { browser, open } = browserOf(host);
		browser.show();
		browser.watch(true);
		open.room = 'second';
		browser.watch(true);
		expect(host.finders.map((finder) => [finder.room, finder.closed])).toEqual([
			['build', true],
			['second', false],
		]);
		expect(vi.getTimerCount()).toBe(1);
		browser.watch(true);
		expect(host.finders).toHaveLength(2);
	});

	it('stops the poll when the panel closes, and when the terminal cannot draw', () => {
		const host = new FakeHost();
		const { browser, changed } = browserOf(host);
		browser.show();
		browser.watch(true);
		browser.watch(false);
		expect(host.finders[0]?.closed).toBe(true);
		browser.watch(true);
		browser.hide();
		expect(browser.open).toBe(false);
		expect(host.finders[1]?.closed).toBe(true);
		expect(changed).toHaveBeenCalledTimes(1);
		const calls = changed.mock.calls.length;
		vi.advanceTimersByTime(TICK_MS * 3);
		expect(changed).toHaveBeenCalledTimes(calls);
	});

	it('leaves no timer after the panel closes', () => {
		const { browser } = browserOf(new FakeHost());
		browser.show();
		browser.watch(true);
		expect(vi.getTimerCount()).toBe(1);
		browser.hide();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('redraws every second so the age moves, and on each change of the viewfinder', () => {
		const host = new FakeHost();
		let now = Date.now();
		const { browser, changed } = browserOf(host, vi.fn(), () => now);
		browser.show();
		browser.watch(true);
		expect(browser.state.cameras).toEqual([]);
		const finder = host.finders[0];
		if (!finder) throw new Error('No viewfinder.');
		finder.state = { cameras: [bench(now)], note: undefined };
		finder.changed();
		expect(changed).toHaveBeenCalledTimes(1);
		const [camera] = browser.state.cameras;
		if (!camera) throw new Error('No camera.');
		expect(camera.name).toBe('bench');
		expect(browser.age(camera)).toBe('0 s ago');
		now += 2_000;
		vi.advanceTimersByTime(TICK_MS);
		expect(changed).toHaveBeenCalledTimes(2);
		expect(browser.age(camera)).toBe('2 s ago');
	});

	it('has no age for a camera with no frame', () => {
		const { browser } = browserOf(new FakeHost());
		expect(browser.age({ ...bench(0), frame: undefined })).toBeUndefined();
	});
});

describe('the camera command', () => {
	it('asks the terminal to open the viewfinder panel', async () => {
		const { session } = await started();
		expect(await session.submit('/camera')).toEqual({ type: 'camera' });
	});
});
