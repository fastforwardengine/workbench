/** The state of the viewfinder panel, and the session command that opens it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
		const browser = new ViewfinderBrowser(host, vi.fn());
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
		new ViewfinderBrowser(host, vi.fn()).watch(true);
		expect(host.finders).toHaveLength(0);
	});

	it('stops the poll when the panel closes, and when the terminal cannot draw', () => {
		const host = new FakeHost();
		const changed = vi.fn();
		const browser = new ViewfinderBrowser(host, changed);
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

	it('redraws every second so the age moves, and on each change of the viewfinder', () => {
		const host = new FakeHost();
		const changed = vi.fn();
		let now = Date.now();
		const browser = new ViewfinderBrowser(host, changed, () => now);
		browser.show();
		browser.watch(true);
		expect(browser.age).toBeUndefined();
		const finder = host.finders[0];
		if (!finder) throw new Error('No viewfinder.');
		finder.state = { sensor: 'bench/camera', frame: frame(now), note: undefined };
		finder.changed();
		expect(changed).toHaveBeenCalledTimes(1);
		expect(browser.state.sensor).toBe('bench/camera');
		now += 2_000;
		vi.advanceTimersByTime(TICK_MS);
		expect(changed).toHaveBeenCalledTimes(2);
		expect(browser.age).toBe('2 s ago');
	});
});

describe('the camera command', () => {
	it('asks the terminal to open the viewfinder panel', async () => {
		const { session } = await started();
		expect(await session.submit('/camera')).toEqual({ type: 'camera' });
	});
});
