import { commitUri, type Message, snapshotUri } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import {
	chipLine,
	citedFiles,
	isRefPick,
	type Known,
	pickIds,
	refItems,
	resolveRef,
	shows,
	systemOfPick,
	systemPick,
} from '../src/view/refs.ts';
import type { Block } from '../src/view/timeline.ts';

const known: Known = {
	room: 'characterization',
	files: ['/library/cell-18650.md', '/shared/my notes.md'],
	seqs: new Set([1, 2, 3]),
};

const AT = '2026-01-01T00:00:00Z';
const DIGEST = '0123456789abcdef'.repeat(4);
const HASH = 'a1b2c3d4e5'.repeat(4);

describe('resolveRef', () => {
	it('resolves a file: URI to a workspace path in the file list', () => {
		const resolved = resolveRef('file:///library/cell-18650.md', known);
		expect(resolved.kind).toBe('file');
		expect(resolved.target).toEqual({ kind: 'file', path: '/library/cell-18650.md' });
	});

	it('decodes the path and drops a fragment or a query', () => {
		expect(resolveRef('file:///shared/my%20notes.md#L3', known).target).toEqual({
			kind: 'file',
			path: '/shared/my notes.md',
		});
		expect(resolveRef('file:///library/cell-18650.md?x=1', known).target?.kind).toBe('file');
	});

	it('marks a file that the workspace does not list', () => {
		const resolved = resolveRef('file:///library/missing.md', known);
		expect(resolved.target).toBeUndefined();
		expect(resolved.problem).toBe('not in the workspace');
	});

	it('refuses a path that leaves the workspace, whatever its encoding', () => {
		const escapes = [
			'file:///../etc/passwd',
			'file:///library/../../etc/passwd',
			'file:///library/%2e%2e/%2e%2e/etc/passwd',
			'file:///library%2F..%2F..%2Fetc%2Fpasswd',
			'file:///library//cell-18650.md',
			'file:///library\\cell-18650.md',
			'file:///library/cell%00.md',
			'file:///library/%zz',
		];
		for (const ref of escapes) expect(resolveRef(ref, known).target, ref).toBeUndefined();
	});

	it('refuses a file: URI with a host or a relative form', () => {
		expect(resolveRef('file://host/etc/passwd', known).target).toBeUndefined();
		expect(resolveRef('file:etc/passwd', known).target).toBeUndefined();
		expect(resolveRef('file:///etc/passwd', known).problem).toBe('not in the workspace');
	});

	it('opens nothing for a lab URI', () => {
		expect(resolveRef('lab:///runs', known)).toMatchObject({
			kind: 'unknown',
			problem: 'this scheme opens nothing',
		});
	});

	it('resolves a message URI of this room to its seq', () => {
		const resolved = resolveRef('ambion://room/characterization/message/2', known);
		expect(resolved.kind).toBe('message');
		expect(resolved.target).toEqual({ kind: 'message', seq: 2 });
	});

	it('marks a message of another room, a message not read yet, and a room ref', () => {
		expect(resolveRef('ambion://room/budget/message/2', known).problem).toBe('in room budget');
		expect(resolveRef('ambion://room/characterization/message/9', known).problem).toMatch(
			/not read yet/,
		);
		expect(resolveRef('ambion://room/characterization', known).target).toBeUndefined();
	});

	it('resolves a snapshot ref of this workspace, and labels it with its path and digest', () => {
		const ref = snapshotUri('workbench', DIGEST, '/shared/readings.csv');
		expect(resolveRef(ref, known)).toMatchObject({
			kind: 'snapshot',
			label: '/shared/readings.csv @01234567',
			target: { kind: 'snapshot', ref },
		});
	});

	it('resolves a commit ref of this workspace, and labels it with its short hash', () => {
		const ref = commitUri('workbench', 'researcher/plan', HASH, { branch: 'led' });
		expect(resolveRef(ref, known)).toMatchObject({
			kind: 'commit',
			label: 'researcher/plan led a1b2c3d',
			target: { kind: 'commit', ref },
		});
	});

	it('marks a snapshot and a commit of another workspace, and opens neither', () => {
		const snapshot = resolveRef(snapshotUri('elsewhere', DIGEST, '/a.csv'), known);
		const commit = resolveRef(commitUri('elsewhere', 'a/r', HASH), known);
		expect([snapshot.target, commit.target]).toEqual([undefined, undefined]);
		expect([snapshot.problem, commit.problem]).toEqual([
			'in workspace elsewhere',
			'in workspace elsewhere',
		]);
	});

	it('marks a scheme it does not know as unknown', () => {
		const resolved = resolveRef('https://example.com/a', known);
		expect(resolved.kind).toBe('unknown');
		expect(resolved.target).toBeUndefined();
	});
});

describe('chipLine', () => {
	const file = resolveRef('file:///library/cell-18650.md', known);
	const missing = resolveRef('file:///library/missing-datasheet-with-a-long-name.md', known);

	it('shows a marker, the kind, and the label', () => {
		expect(chipLine(file, 80)).toBe('↗ file  /library/cell-18650.md');
		expect(chipLine(resolveRef('ambion://room/characterization/message/2', known), 80)).toBe(
			'↗ message  2',
		);
	});

	it('marks a ref that does not resolve, and says why', () => {
		expect(chipLine(resolveRef('gopher://x', known), 80)).toBe(
			'✗ ref  gopher://x  (this scheme opens nothing)',
		);
	});

	it('fits every chip to the width, and keeps the marker and the reason', () => {
		for (const width of [40, 50, 80]) {
			for (const item of [file, missing])
				expect(chipLine(item, width).length).toBeLessThanOrEqual(width);
		}
		const line = chipLine(missing, 50);
		expect(line.startsWith('✗ file  ')).toBe(true);
		expect(line).toContain('…');
		expect(line.endsWith('(not in the workspace)')).toBe(true);
	});
});

const said = (seq: number, refs?: string[]): Message =>
	({ seq, kind: 'said', from: 'design', text: `m${seq}`, at: '', refs }) as Message;

describe('refItems', () => {
	const blocks: Block[] = [
		{
			type: 'message',
			message: said(1, [
				'ambion://room/characterization/message/2',
				'file:///library/cell-18650.md',
			]),
			role: 'said',
		},
		{ type: 'message', message: said(2), role: 'said' },
		{
			type: 'message',
			message: said(3, ['file:///shared/my%20notes.md']),
			role: 'said',
		},
	];

	it('lists the refs of the messages in order, with one id each', () => {
		const items = refItems(blocks, known);
		expect(items.map((item) => item.id)).toEqual(['1#0', '1#1', '3#0']);
		expect(items.map((item) => item.resolved.kind)).toEqual(['message', 'file', 'file']);
	});
});

describe('citedFiles', () => {
	const at = (minute: number) => `2026-01-01T12:${String(minute).padStart(2, '0')}:00Z`;
	const cite = (seq: number, from: string, refs: string[], minute = seq): Message =>
		({ seq, kind: 'said', from, text: `m${seq}`, at: at(minute), refs }) as Message;
	const FILE = 'file:///library/cell-18650.md';
	const SNAP_A = snapshotUri('workbench', DIGEST, '/shared/my notes.md');
	const SNAP_B = snapshotUri('workbench', 'f'.repeat(64), '/shared/my notes.md');
	const COMMIT_A = commitUri('workbench', 'researcher/plan', HASH, { branch: 'led' });
	const COMMIT_B = commitUri('workbench', 'researcher/plan', 'b'.repeat(40), { branch: 'led' });

	it('lists each path once, newest citation first, with the author and the time of that citation', () => {
		const rows = citedFiles(
			[
				cite(1, 'priya', [FILE]),
				cite(2, 'engineer', ['file:///shared/my%20notes.md']),
				cite(3, 'researcher', [FILE]),
			],
			known,
		);
		expect(rows.map((row) => [row.key, row.author, row.at, row.seq])).toEqual([
			['/library/cell-18650.md', 'researcher', at(3), 3],
			['/shared/my notes.md', 'engineer', at(2), 2],
		]);
	});

	it('groups the snapshots of one path and the file itself as the versions of one row', () => {
		const [row, ...rest] = citedFiles(
			[
				cite(1, 'engineer', [SNAP_A]),
				cite(2, 'researcher', ['file:///shared/my%20notes.md']),
				cite(3, 'engineer', [SNAP_B, SNAP_B]),
			],
			known,
		);
		expect(rest).toEqual([]);
		expect(row).toMatchObject({
			key: '/shared/my notes.md',
			label: '/shared/my notes.md',
			open: SNAP_B,
			author: 'engineer',
			seq: 3,
		});
		expect(row?.opens).toEqual([
			{ open: SNAP_A, seq: 1 },
			{ open: '/shared/my notes.md', seq: 2 },
			{ open: SNAP_B, seq: 3 },
		]);
	});

	it('groups the commits of one repository and keeps the label of the newest', () => {
		const rows = citedFiles(
			[cite(1, 'engineer', [COMMIT_A]), cite(2, 'engineer', [COMMIT_B])],
			known,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			key: 'commit:researcher/plan',
			open: COMMIT_B,
			label: 'researcher/plan led bbbbbbb',
		});
		expect(rows[0]?.opens).toEqual([
			{ open: COMMIT_A, seq: 1 },
			{ open: COMMIT_B, seq: 2 },
		]);
	});

	it('leaves out a ref that opens no file: a message, a missing file, another workspace, a scheme', () => {
		const rows = citedFiles(
			[
				cite(1, 'priya', [
					'ambion://room/characterization/message/2',
					'file:///library/missing.md',
					snapshotUri('elsewhere', DIGEST, '/a.csv'),
					'https://example.com/a',
				]),
				cite(2, 'priya', []),
			],
			known,
		);
		expect(rows).toEqual([]);
	});

	it('reads only the messages that say something, and shows the author as the message names it', () => {
		const presence = {
			seq: 1,
			kind: 'joined',
			from: 'priya',
			at: at(1),
			refs: [FILE],
		} as unknown as Message;
		const rows = citedFiles([presence, cite(2, 'engineer', [FILE])], known);
		expect(rows.map((row) => row.author)).toEqual(['engineer']);
	});
});

describe('the system rows', () => {
	const FILE = 'file:///library/cell-18650.md';
	const system = (seq: number, open?: true): Block => ({
		type: 'message',
		role: 'system',
		message: { seq, kind: 'system', text: 'breakout x: Done.', at: AT, refs: [FILE] } as never,
		...(open ? { open } : {}),
	});
	const said = (seq: number, refs: string[]): Block => ({
		type: 'message',
		role: 'said',
		message: { seq, kind: 'said', from: 'engineer', text: 'Hi', at: AT, refs } as never,
	});

	it('names a row by the seq of its message', () => {
		expect(systemPick(12)).toBe('system:12');
		expect(systemOfPick('system:12')).toBe(12);
		expect(systemOfPick('12#0')).toBeUndefined();
		expect(systemOfPick('stay:act-1')).toBeUndefined();
		expect(systemOfPick('system:x')).toBeUndefined();
	});

	it('tells a ref pick from a row pick', () => {
		expect(isRefPick('4#0')).toBe(true);
		expect(isRefPick('system:4')).toBe(false);
		expect(isRefPick('stay:act-1')).toBe(false);
	});

	it('gives the row of a folded system message and no ref', () => {
		const blocks = [system(2), said(3, [FILE])];
		expect(pickIds(blocks, known)).toEqual(['system:2', '3#0']);
		expect(refItems(blocks, known).map((item) => item.id)).toEqual(['3#0']);
	});

	it('gives the row and then the refs of an open system message', () => {
		const blocks = [system(2, true), said(3, [FILE])];
		expect(pickIds(blocks, known)).toEqual(['system:2', '2#0', '3#0']);
		expect(refItems(blocks, known).map((item) => item.id)).toEqual(['2#0', '3#0']);
	});

	it('shows a folded system message as shown, so a jump finds its row', () => {
		expect(shows([system(2)], 2)).toBe(true);
		expect(shows([system(2)], 3)).toBe(false);
	});
});
