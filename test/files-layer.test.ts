/**
 * The rows of the files layer: what the open room cites, the files of the workspace
 * by group, the search, and the columns at a wide and a narrow width. The panel is a
 * real widget on OpenTUI's headless renderer.
 */
import { snapshotUri } from '@ambionframework/ambion';
import { BoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileContent, FileEntry } from '../src/host/host.ts';
import { FileBrowser } from '../src/terminal/state/browser.ts';
import { DockPanel } from '../src/terminal/widgets/dock.ts';
import { listLines, timeOfDay, visibleLines } from '../src/terminal/widgets/file-list.ts';
import { FilesPanel } from '../src/terminal/widgets/files-panel.ts';
import { type CitedFile, citedFiles } from '../src/view/refs.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const files: FileEntry[] = [
	{
		path: '/library/hm310p-manual.pdf',
		size: 421_888,
		group: '/library',
		relative: 'hm310p-manual.pdf',
	},
	{ path: '/shared/kit.md', size: 6_144, group: '/shared', relative: 'kit.md' },
	{
		path: '/shared/rf/ldo-compare.md',
		size: 3_072,
		group: '/shared',
		relative: 'rf/ldo-compare.md',
	},
	{ path: '/home/engineer/sweep.py', size: 2_048, group: '~engineer', relative: 'sweep.py' },
];

const SWEEP_A = snapshotUri('workbench', 'a'.repeat(64), '/home/engineer/sweep.py');
const SWEEP_B = snapshotUri('workbench', 'b'.repeat(64), '/home/engineer/sweep.py');
const AT = (minute: number) => `2026-01-01T12:${String(minute).padStart(2, '0')}:00`;

/** The messages that cite: the kit, two snapshots of the sweep, and a file of the shared folder. */
const messages = [
	{
		seq: 1,
		kind: 'said',
		from: 'engineer',
		text: 'a',
		at: AT(10),
		refs: ['file:///shared/kit.md'],
	},
	{ seq: 2, kind: 'said', from: 'engineer', text: 'b', at: AT(20), refs: [SWEEP_A] },
	{ seq: 3, kind: 'said', from: 'engineer', text: 'c', at: AT(30), refs: [SWEEP_B] },
	{
		seq: 4,
		kind: 'said',
		from: 'priya',
		text: 'd',
		at: AT(41),
		refs: ['file:///shared/rf/ldo-compare.md'],
	},
] as never;

const cited: CitedFile[] = citedFiles(messages, {
	room: 'build',
	files: files.map((file) => file.path),
	seqs: new Set([1, 2, 3, 4]),
});

const load = async (path: string): Promise<FileContent> => ({
	path,
	text: `text of ${path}`,
	truncated: false,
});

/** A browser over the files and the citations. */
function browser(): FileBrowser {
	const made = new FileBrowser(load, () => {});
	made.show(files, undefined, cited);
	return made;
}

describe('the rows of the files layer', () => {
	it('puts what the room cites first, newest citation first, and then the files by group', () => {
		const rows = browser().matches.map((row) => [row.kind, row.group, row.label]);
		expect(rows).toEqual([
			['cited', 'Cited here', '/shared/rf/ldo-compare.md'],
			['cited', 'Cited here', '/home/engineer/sweep.py'],
			['cited', 'Cited here', '/shared/kit.md'],
			['file', '/library', 'hm310p-manual.pdf'],
			['file', '/shared', 'kit.md'],
			['file', '/shared', 'rf/ldo-compare.md'],
			['file', '~engineer', 'sweep.py'],
		]);
	});

	it('counts the cited rows and every row', () => {
		const made = browser();
		expect([made.cited, made.total]).toEqual([3, 7]);
	});

	it('links a file of the workspace to its citation, and a file that nothing cites to none', () => {
		const marks = browser()
			.matches.filter((row) => row.kind === 'file')
			.map((row) => [row.label, row.cite?.seq]);
		expect(marks).toEqual([
			['hm310p-manual.pdf', undefined],
			['kit.md', 1],
			['rf/ldo-compare.md', 4],
			['sweep.py', 3],
		]);
	});

	it('finds a row when every word of the search is in its path, in both parts', () => {
		const made = browser();
		made.type('shared kit');
		expect(made.matches.map((row) => [row.kind, row.path])).toEqual([
			['cited', '/shared/kit.md'],
			['file', '/shared/kit.md'],
		]);
		made.clear();
		made.type('engineer sweep');
		expect(made.matches.map((row) => row.kind)).toEqual(['cited', 'file']);
		made.type(' nothing');
		expect(made.matches).toEqual([]);
	});

	it('names the message that Enter goes to: the newest one that cites the chosen file', () => {
		const made = browser();
		expect(made.citedBy).toBe(4);
		made.move(1);
		expect(made.citedBy).toBe(3);
		made.move(2);
		expect(made.selected?.label).toBe('hm310p-manual.pdf');
		expect(made.citedBy).toBeUndefined();
		made.move(1);
		expect([made.selected?.label, made.citedBy]).toEqual(['kit.md', 1]);
	});

	it('starts on the row of the path, and opens an older snapshot in the row of its file', async () => {
		const made = new FileBrowser(load, () => {});
		made.show(files, '/shared/rf/ldo-compare.md', cited);
		expect(made.selected?.kind).toBe('cited');
		made.show(files, SWEEP_A, cited);
		await wait(10);
		expect(made.selected).toMatchObject({
			kind: 'cited',
			path: SWEEP_A,
			label: '/home/engineer/sweep.py',
		});
		// Enter goes to the message that cited that version, not to the newest one.
		expect(made.citedBy).toBe(2);
		expect(made.file?.path).toBe(SWEEP_A);
	});

	it('lists a room that cites nothing as the files alone', () => {
		const made = new FileBrowser(load, () => {});
		made.show(files);
		expect([made.cited, made.total]).toEqual([0, 4]);
		expect(made.matches.every((row) => row.kind === 'file')).toBe(true);
	});
});

/** A panel in a dock, of the width that the terminal gives it. */
async function mount(width: number, height = 30, overlay?: number) {
	const setup = await createTestRenderer({ width, height });
	cleanups.push(() => setup.renderer.destroy());
	const body = new BoxRenderable(setup.renderer, {
		flexDirection: 'row',
		width: '100%',
		height: '100%',
	});
	setup.renderer.root.add(body);
	const panel = new FilesPanel(setup.renderer);
	const dock = new DockPanel(setup.renderer);
	dock.add(panel.root);
	panel.root.visible = true;
	dock.layout({ visible: true, overlay, keyed: true });
	dock.draw(['files'], 'files');
	body.add(dock.root);
	const made = browser();
	await wait(10);
	panel.draw(made);
	const frame = async () => {
		await setup.renderOnce();
		await setup.renderOnce();
		return setup.captureCharFrame();
	};
	return { panel, made, frame };
}

/** The lines of a frame without the dock edge and the trailing spaces. */
const lines = (frame: string): string[] =>
	frame.split('\n').map((line) => line.replace(/^\s*│ ?/, '').trimEnd());

describe('the window of the list', () => {
	it('shows the first lines when no row is chosen', () => {
		const lines = listLines(browser().matches, 60);
		expect(visibleLines(lines, 99, 8)).toEqual([0, 8]);
		expect(visibleLines(lines.slice(0, 3), 99, 8)).toEqual([0, 3]);
	});

	it('takes the words of the status line away with one redraw', () => {
		let drawn = 0;
		const made = new FileBrowser(load, () => {
			drawn += 1;
		});
		made.untell();
		expect(drawn).toBe(0);
		made.tell('Nothing cites this file.');
		made.untell();
		expect([made.notice, drawn]).toEqual([undefined, 2]);
	});
});

describe('the frame of the files layer', () => {
	it('draws the section, the groups, the marks, the versions, the time, and the size at a wide width', async () => {
		const { frame } = await mount(120, 30, 100);
		const shown = lines(await frame());
		const at = shown.indexOf('Cited here');
		expect(shown[at - 1]).toMatch(/^Files › ▌ +7 of 7 · 3 cited$/);
		expect(shown.slice(at, at + 12).map((line) => line.replace(/(?<=\S) {2,}/g, ' '))).toEqual([
			'Cited here',
			`▸ /shared/rf/ldo-compare.md priya ${timeOfDay(AT(41))}`,
			`  /home/engineer/sweep.py engineer · 2 versions ${timeOfDay(AT(30))}`,
			`  /shared/kit.md engineer ${timeOfDay(AT(10))}`,
			'',
			'/library',
			'  hm310p-manual.pdf 412.0 KB',
			'/shared',
			'• kit.md 6.0 KB',
			'• rf/ldo-compare.md 3.0 KB',
			'~engineer',
			'• sweep.py 2.0 KB',
		]);
	});

	it('aligns the time and the size on the right edge of the list', async () => {
		const { frame } = await mount(120, 30, 100);
		const shown = lines(await frame());
		const ends = ['▸ /shared/rf/ldo-compare.md', '  hm310p-manual.pdf'].map((start) => {
			const line = shown.find((one) => one.startsWith(start)) ?? '';
			return line.length;
		});
		expect(new Set(ends).size).toBe(1);
	});

	it('drops the time and the long form of the versions below 60 columns, and keeps the size', async () => {
		const { frame } = await mount(100, 30);
		const text = await frame();
		expect(text).not.toContain(timeOfDay(AT(41)));
		expect(text).not.toContain('versions');
		expect(text).toContain('engineer ·2');
		expect(text).toMatch(/hm310p-manual\.pdf +412\.0 KB/);
	});

	it('drops the size below 44 columns, and cuts the middle of a path so the file name stays', async () => {
		const { frame } = await mount(60, 30);
		const text = await frame();
		expect(text).not.toContain('KB');
		const shown = lines(text);
		const row = shown.find((line) => line.includes('ldo-compare.md') && line.startsWith('▸')) ?? '';
		expect(row).toMatch(/^▸ \/sha[a-z]*…\/ldo-compare\.md +priya$/);
		expect(Math.max(...shown.map((line) => line.length))).toBeLessThanOrEqual(40);
	});

	it('keeps the heading of the chosen group in view in a long list', async () => {
		const { made, panel, frame } = await mount(120, 30, 100);
		for (let step = 0; step < 6; step += 1) made.move(1);
		panel.draw(made);
		await wait(10);
		const shown = lines(await frame());
		expect(shown).toContain('~engineer');
		expect(shown.find((line) => line.startsWith('▸'))).toMatch(/^▸ sweep\.py/);
	});
});
