/** The title of the terminal window: its text for each state, and its writes. */
import { describe, expect, it, vi } from 'vitest';
import {
	TerminalTitle,
	type TitleSource,
	titleOf,
	WAITS_MARK,
	WORKS_MARK,
} from '../src/terminal/state/title.ts';

const PRODUCT = 'Workbench Lab';

const source = (patch: Partial<TitleSource> = {}): TitleSource => ({
	identity: {},
	room: 'build',
	parent: undefined,
	attention: [],
	working: undefined,
	sending: false,
	...patch,
});

describe('titleOf', () => {
	it('shows the room alone while the room is idle', () => {
		expect(titleOf(source(), PRODUCT)).toBe('build — Workbench Lab');
	});

	it('marks the room and names the seat while a seat works', () => {
		const working = { seat: 'engineer' };
		expect(titleOf(source({ working }), PRODUCT)).toBe(
			`${WORKS_MARK} build · engineer — Workbench Lab`,
		);
	});

	it('marks the room, with no seat, while a message goes out', () => {
		expect(titleOf(source({ sending: true }), PRODUCT)).toBe(`${WORKS_MARK} build — Workbench Lab`);
	});

	it('marks the room when it waits for the person', () => {
		const attention = ['The exchange from message 3 waits for your reply.'];
		expect(titleOf(source({ attention }), PRODUCT)).toBe(`${WAITS_MARK} build — Workbench Lab`);
	});

	it('puts a wait before a working seat and before a send', () => {
		const attention = ['The exchange from message 3 waits for your reply.'];
		const busy = source({ attention, working: { seat: 'engineer' }, sending: true });
		expect(titleOf(busy, PRODUCT)).toBe(`${WAITS_MARK} build — Workbench Lab`);
	});

	it('puts a working seat before a send', () => {
		const busy = source({ working: { seat: 'researcher' }, sending: true });
		expect(titleOf(busy, PRODUCT)).toBe(`${WORKS_MARK} build · researcher — Workbench Lab`);
	});

	it('shows the path of a breakout room, with the short name', () => {
		const child = { room: 'build-datasheets', parent: 'build' };
		expect(titleOf(source(child), PRODUCT)).toBe('build › datasheets — Workbench Lab');
		expect(titleOf(source({ ...child, working: { seat: 'engineer' } }), PRODUCT)).toBe(
			`${WORKS_MARK} build › datasheets · engineer — Workbench Lab`,
		);
		expect(titleOf(source({ ...child, sending: true }), PRODUCT)).toBe(
			`${WORKS_MARK} build › datasheets — Workbench Lab`,
		);
		const attention = ['The exchange from message 3 waits for your reply.'];
		expect(titleOf(source({ ...child, attention }), PRODUCT)).toBe(
			`${WAITS_MARK} build › datasheets — Workbench Lab`,
		);
	});

	it('shows the whole name of a breakout room when the prefix of the parent does not match', () => {
		const child = source({ room: 'tuners', parent: 'build' });
		expect(titleOf(child, PRODUCT)).toBe('build › tuners — Workbench Lab');
	});

	it('shows the product name alone without a person', () => {
		expect(titleOf(source({ identity: undefined }), PRODUCT)).toBe(PRODUCT);
	});

	it('shows the product name alone without an open room', () => {
		expect(titleOf(source({ room: '', sending: true }), PRODUCT)).toBe(PRODUCT);
	});
});

describe('TerminalTitle', () => {
	it('writes the first text and each change, and skips a repeat', () => {
		const write = vi.fn();
		const title = new TerminalTitle(write);
		title.show('build — Workbench Lab');
		title.show('build — Workbench Lab');
		title.show(`${WORKS_MARK} build · engineer — Workbench Lab`);
		title.show(`${WORKS_MARK} build · engineer — Workbench Lab`);
		title.show('build — Workbench Lab');
		expect(write.mock.calls).toEqual([
			['build — Workbench Lab'],
			[`${WORKS_MARK} build · engineer — Workbench Lab`],
			['build — Workbench Lab'],
		]);
	});
});
