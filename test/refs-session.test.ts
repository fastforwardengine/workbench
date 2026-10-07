import { commitUri, snapshotUri } from '@ambionframework/ambion';
import type { KeyEvent } from '@opentui/core';
import { describe, expect, it, vi } from 'vitest';
import { FilesSurface } from '../src/terminal/app/files-surface.ts';
import { type KeyParts, Keys } from '../src/terminal/app/keys.ts';
import type { FilesPanel } from '../src/terminal/widgets/files-panel.ts';
import { type FakeHost, started, view } from './fake-host.ts';
import { quietVoice } from './voice-fakes.ts';

const AT = '2026-01-01T00:00:00Z';
const said = (seq: number, from: string, refs?: string[]) => ({
	seq,
	kind: 'said',
	from,
	text: `${from} ${seq}`,
	at: AT,
	refs,
});
const exchange = {
	from: 1,
	through: 3,
	status: 'closed',
	person: 'priya',
	at: AT,
	outcome: { kind: 'complete' },
	summary: { kind: 'silent' },
	activations: [],
};

const FILE = 'file:///datasheets/cell-18650.md';
const MISSING = 'file:///datasheets/missing.md';
const HOST_FILE = 'file:///etc/passwd';
const SNAPSHOT = snapshotUri('workbench', 'ab'.repeat(32), '/shared/readings.csv');
const COMMIT = commitUri('workbench', 'researcher/plan', 'cd'.repeat(20), { branch: 'led' });

/** A room with a closed exchange of two messages, then two messages that cite. */
function room(host: FakeHost, cite = true): void {
	host.table.set(
		'characterization',
		view('characterization', {
			participants: [{ name: 'priya', kind: 'person' }],
			messages: [
				said(1, 'priya'),
				said(2, 'design', cite ? [FILE, 'ambion://room/characterization/message/1'] : undefined),
				said(3, 'researcher'),
				said(4, 'priya', cite ? ['ambion://room/characterization/message/3', MISSING] : undefined),
				said(
					5,
					'design',
					cite ? [HOST_FILE, 'https://example.com/x', 'lab:///missing'] : undefined,
				),
			],
			exchanges: [exchange],
		}),
	);
}

async function open() {
	const made = await started();
	made.host.fileList = [{ path: '/datasheets/cell-18650.md', size: 797 }];
	room(made.host);
	await made.session.refreshRooms();
	await made.session.refresh();
	return made;
}

/** The parts of the terminal that the keys touch, as records. */
function keysOver(session: Awaited<ReturnType<typeof open>>['session']) {
	const log: string[] = [];
	const root = { visible: true, height: 20 };
	const parts = {
		renderer: { width: 120 },
		session,
		composer: { blur: () => log.push('blur'), focus: () => log.push('focus'), setText: () => {} },
		palette: { refresh: () => {} },
		painter: {
			revealMessage: (seq: number) => log.push(`reveal:${seq}`),
			invalidate: () => {},
		},
		// The real surface over a panel that draws nothing: the keys of the files panel are the code under test.
		surfaces: {
			files: new FilesSurface(session.browser, {
				root: {},
				fill: () => {},
				draw: () => {},
				scrollBy: () => {},
				page: 4,
			} as unknown as FilesPanel),
			processes: {} as never,
		},
		transcript: { root, scrollBy: () => {} },
		voice: quietVoice(),
		render: () => {},
	};
	const keys = new Keys(parts as unknown as KeyParts);
	const press = (name: string) =>
		keys.onKey({ name, ctrl: false, meta: false, sequence: '', preventDefault() {} } as KeyEvent);
	return { keys, press, log, root };
}

describe('the refs of a message', () => {
	it('lists the refs of every message, top to bottom', async () => {
		const { session } = await open();
		expect(session.refItems.map((item) => item.id)).toEqual([
			'2#0',
			'2#1',
			'4#0',
			'4#1',
			'5#0',
			'5#1',
			'5#2',
		]);
	});

	it('marks each ref that does not resolve, and each one outside the workspace', async () => {
		const { session } = await open();
		const state = session.refItems.map((item) => [item.id, Boolean(item.resolved.target)]);
		expect(state).toEqual([
			['2#0', true],
			['2#1', true],
			['4#0', true],
			['4#1', false],
			['5#0', false],
			['5#1', false],
			['5#2', false],
		]);
	});

	it('opens a file ref in the same preview the files panel gives', async () => {
		const { session, host } = await open();
		const intent = await session.openRef('2#0');
		expect(intent).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/datasheets/cell-18650.md'));
		expect(session.browser.open).toBe(true);
		expect(session.browser.selected?.path).toBe('/datasheets/cell-18650.md');
		expect(host.reads).toContain('/datasheets/cell-18650.md');
	});

	it('opens a snapshot ref and a commit ref in the panel, through their own host calls', async () => {
		const { session, host } = await started();
		host.fileList = [{ path: '/datasheets/cell-18650.md', size: 797 }];
		host.table.set(
			'characterization',
			view('characterization', {
				participants: [{ name: 'priya', kind: 'person' }],
				messages: [said(1, 'priya'), said(2, 'design', [SNAPSHOT, COMMIT])],
			}),
		);
		await session.refresh();
		expect(session.refItems.map((item) => item.resolved.kind)).toEqual(['snapshot', 'commit']);
		expect(await session.openRef('2#0')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe(SNAPSHOT));
		expect(session.browser.selected).toMatchObject({
			kind: 'snapshot',
			label: '/shared/readings.csv @abababab',
		});
		expect(session.browser.matches.map((entry) => entry.path)).toEqual([
			SNAPSHOT,
			'/datasheets/cell-18650.md',
		]);
		await session.openRef('2#1');
		await vi.waitFor(() => expect(session.browser.file?.path).toBe(COMMIT));
		expect(host.reads).toEqual([SNAPSHOT, COMMIT]);
	});

	it('opens nothing for a ref that does not resolve, and reads nothing from the host', async () => {
		const { session, host } = await open();
		host.reads.length = 0;
		for (const id of ['4#1', '5#0', '5#1', '5#2']) {
			expect(await session.openRef(id)).toBeUndefined();
		}
		expect(session.browser.open).toBe(false);
		expect(host.reads).toEqual([]);
	});

	it('jumps to the message that a message ref cites, and clears the focus', async () => {
		const { session } = await open();
		expect(session.refItems.find((item) => item.id === '4#0')?.resolved.target).toEqual({
			kind: 'message',
			seq: 3,
		});
		await session.openRef('4#0');
		expect(session.focus).toBe(3);
		session.clearFocus();
		expect(session.focus).toBeUndefined();
	});
});

describe('the ref keys', () => {
	it('chooses a ref with Tab, moves with Up and Down, and goes back with Escape', async () => {
		const { session } = await open();
		const { keys, press, log } = keysOver(session);
		press('tab');
		expect(keys.mode).toBe('refs');
		expect(log).toContain('blur');
		expect(keys.picking).toBe('5#2');
		press('up');
		expect(keys.picking).toBe('5#1');
		press('down');
		press('down');
		expect(keys.picking).toBe('5#2');
		press('escape');
		expect(keys.mode).toBe('compose');
		expect(log).toContain('focus');
	});

	it('says so when no shown message has a ref', async () => {
		const { session, host } = await started();
		room(host, false);
		await session.refresh();
		const { keys, press } = keysOver(session);
		press('tab');
		expect(keys.mode).toBe('compose');
		expect(session.notice).toMatch(/No shown message has a ref/);
	});

	it('opens the file preview from a chosen ref, and Escape returns to the refs', async () => {
		const { session } = await open();
		const { keys, press, root } = keysOver(session);
		press('tab');
		while (keys.picking !== '2#0') press('up');
		press('return');
		await vi.waitFor(() => expect(keys.mode).toBe('files'));
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/datasheets/cell-18650.md'));
		press('escape');
		expect(keys.mode).toBe('refs');
		expect(session.browser.open).toBe(false);
		expect(root.visible).toBe(true);
	});

	it('returns to the composer when the panel opened from a command', async () => {
		const { session } = await open();
		const { keys, press } = keysOver(session);
		await session.submit('/files');
		keys.openFiles();
		expect(keys.mode).toBe('files');
		press('escape');
		expect(keys.mode).toBe('compose');
	});

	it('jumps to the message a message ref cites', async () => {
		const { session } = await open();
		const { keys, press, log } = keysOver(session);
		press('tab');
		while (keys.picking !== '4#0') press('up');
		press('return');
		await vi.waitFor(() => expect(session.focus).toBe(3));
		expect(log).toContain('reveal:3');
		expect(keys.mode).toBe('refs');
		press('down');
		expect(session.focus).toBeUndefined();
	});

	it('does nothing when Enter meets a ref that does not resolve', async () => {
		const { session } = await open();
		const { keys, press } = keysOver(session);
		press('tab');
		expect(keys.picking).toBe('5#2');
		press('return');
		expect(keys.mode).toBe('refs');
		expect(session.browser.open).toBe(false);
	});
});
