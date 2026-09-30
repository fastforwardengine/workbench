import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachFile, imageMimeType, isImagePath } from '../src/host/files.ts';
import { readSnapshotFile } from '../src/host/previews.ts';
import {
	attachCommand,
	pastedImagePath,
	type StagedAttachment,
} from '../src/terminal/state/attachments.ts';
import { FakeHost, started } from './fake-host.ts';
import { PNG } from './png.ts';

const directories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function folder(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-attach-'));
	directories.push(directory);
	return directory;
}

describe('the picture types', () => {
	it.each([
		['/a/photo.PNG', 'image/png'],
		['/a/photo.jpg', 'image/jpeg'],
		['/a/photo.jpeg', 'image/jpeg'],
		['/a/anim.gif', 'image/gif'],
		['/a/pic.webp', 'image/webp'],
	])('names %s as %s', (path, type) => {
		expect(isImagePath(path)).toBe(true);
		expect(imageMimeType(path)).toBe(type);
	});

	it('takes a table, a note, and a path with no extension for no picture', () => {
		for (const path of ['/a/data.db', '/a/notes.md', '/a/png', '/a/pic.png.txt'])
			expect(isImagePath(path), path).toBe(false);
		expect(imageMimeType('/a/notes.md')).toBe('application/octet-stream');
	});
});

describe('pastedImagePath', () => {
	it.each([
		['/Users/priya/Desktop/bench.png', '/Users/priya/Desktop/bench.png'],
		['  /tmp/frame.JPG\n', '/tmp/frame.JPG'],
		['~/Pictures/board.webp', '~/Pictures/board.webp'],
	])('offers %j to /attach', (pasted, path) => {
		expect(pastedImagePath(pasted)).toBe(path);
	});

	it.each([
		'',
		'   ',
		'the board is on the left.png',
		'/tmp/one.png\n/tmp/two.png',
		'/tmp/my photo.png',
		'relative/pic.png',
		'./pic.png',
		'/tmp/notes.md',
		'/tmp/data.db',
		'https://example.com/pic.png',
	])('offers %j to nothing', (pasted) => {
		expect(pastedImagePath(pasted)).toBeUndefined();
	});
});

describe('attachFile', () => {
	function open2() {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		return workspace;
	}

	it('copies the file into /attachments and snapshots it, so the ref gives the bytes back', async () => {
		const dir = await folder();
		await writeFile(join(dir, 'bench.png'), PNG);
		const workspace = open2();
		try {
			const attached = await attachFile(workspace, join(dir, 'bench.png'));
			expect(attached.path).toMatch(/^\/attachments\/\d+-bench\.png$/);
			expect(attached.size).toBe(PNG.length);
			expect(attached.ref).toMatch(
				/^ambion:\/\/workspace\/workbench\/snapshot\/[0-9a-f]{64}\/attachments\/\d+-bench\.png$/,
			);
			expect(Buffer.from(await workspace.readSnapshot(attached.ref))).toEqual(PNG);
		} finally {
			await workspace.dispose();
		}
	});

	it('never overwrites an earlier attachment of the same name, also in the same millisecond', async () => {
		const dir = await folder();
		const workspace = open2();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.parse('2026-09-29T12:00:00Z'));
		try {
			await writeFile(join(dir, 'a.png'), Buffer.from('first'));
			const first = await attachFile(workspace, join(dir, 'a.png'));
			await writeFile(join(dir, 'a.png'), Buffer.from('second'));
			const second = await attachFile(workspace, join(dir, 'a.png'));
			expect(second.path).not.toBe(first.path);
			expect(new TextDecoder().decode(await workspace.readSnapshot(first.ref))).toBe('first');
			expect(new TextDecoder().decode(await workspace.readSnapshot(second.ref))).toBe('second');
		} finally {
			await workspace.dispose();
		}
	});

	it('reads a path under ~/ from the home folder', async () => {
		const home = await folder();
		await mkdir(join(home, 'Pictures'));
		await writeFile(join(home, 'Pictures', 'board.png'), PNG);
		const workspace = open2();
		const before = process.env.HOME;
		process.env.HOME = home;
		try {
			const attached = await attachFile(workspace, '~/Pictures/board.png');
			expect(attached.size).toBe(PNG.length);
		} finally {
			process.env.HOME = before;
			await workspace.dispose();
		}
	});

	it('refuses a missing file, a folder, and a file over 8 MiB, with one line each', async () => {
		const dir = await folder();
		const workspace = open2();
		const big = await open(join(dir, 'big.png'), 'w');
		await big.truncate(8 * 1_048_576 + 1);
		await big.close();
		try {
			await expect(attachFile(workspace, join(dir, 'missing.png'))).rejects.toThrow(
				/^Cannot read .*missing\.png: /,
			);
			await expect(attachFile(workspace, dir)).rejects.toThrow(/^Cannot read /);
			await expect(attachFile(workspace, join(dir, 'big.png'))).rejects.toThrow(
				'/attach takes files up to 8 MiB.',
			);
		} finally {
			await workspace.dispose();
		}
	});

	it('gives the panel a picture for the snapshot of a picture, and a note when it is too large', async () => {
		const dir = await folder();
		await writeFile(join(dir, 'bench.png'), PNG);
		const workspace = open2();
		try {
			const { ref } = await attachFile(workspace, join(dir, 'bench.png'));
			const shown = await readSnapshotFile(workspace, ref);
			expect(shown.text).toBe('');
			expect(shown.image?.mimeType).toBe('image/png');
			expect(Buffer.from(shown.image?.data ?? [])).toEqual(PNG);
		} finally {
			await workspace.dispose();
		}
	});
});

describe('attachCommand', () => {
	const target = () => ({ pendingRefs: [] as StagedAttachment[] });

	it('stages the copy as a ref of the next message, and says so', async () => {
		const host = new FakeHost();
		const staged = target();
		const done = await attachCommand(host, staged, '  /tmp/bench.png ');
		expect(host.attached).toEqual(['/tmp/bench.png']);
		expect(staged.pendingRefs).toHaveLength(1);
		expect(staged.pendingRefs[0]).toMatchObject({ path: '/attachments/1-bench.png' });
		expect(done).toEqual({
			notice: 'Attached /attachments/1-bench.png. It goes with your next message.',
		});
	});

	it('asks for a path when there is none, and stages nothing', async () => {
		const staged = target();
		expect(await attachCommand(new FakeHost(), staged, '   ')).toEqual({
			notice: 'Use /attach <local file path>.',
		});
		expect(staged.pendingRefs).toEqual([]);
	});

	it('returns the failure of the copy and stages nothing', async () => {
		const host = new FakeHost();
		host.attachFailure = 'Cannot read /tmp/none.png: no such file';
		const staged = target();
		const done = await attachCommand(host, staged, '/tmp/none.png');
		expect('error' in done && String(done.error)).toMatch(/no such file/);
		expect(staged.pendingRefs).toEqual([]);
	});

	it('stages the file in the array that the target names when the copy ends', async () => {
		const host = new FakeHost();
		const staged = target();
		const first = host.attach.bind(host);
		host.attach = async (path: string) => {
			staged.pendingRefs = [];
			return first(path);
		};
		await attachCommand(host, staged, '/tmp/late.png');
		expect(staged.pendingRefs).toHaveLength(1);
	});
});

describe('Session, with attachments', () => {
	it('sends the staged refs with the next message, once, and only when the send worked', async () => {
		const { host, session } = await started();
		await session.submit('/attach /tmp/one.png');
		await session.submit('/attach /tmp/two.png');
		expect(session.pendingRefs).toHaveLength(2);
		host.failNext = 'offline';
		await session.submit('Look at these.');
		expect(host.sentRefs).toEqual([]);
		expect(session.pendingRefs).toHaveLength(2);
		await session.submit('Look at these.');
		expect(host.sentRefs).toHaveLength(1);
		expect(host.sentRefs[0]).toHaveLength(2);
		expect(host.sentRefs[0]?.[0]).toContain('/attachments/1-one.png');
		expect(session.pendingRefs).toEqual([]);
		await session.submit('And now?');
		expect(host.sentRefs[1]).toEqual([]);
	});

	it('drops the staged files when the person moves to another room', async () => {
		const { session } = await started();
		await session.submit('/attach /tmp/one.png');
		await session.submit('/room budget');
		expect(session.pendingRefs).toEqual([]);
	});

	it('shows the failure of an attach, and keeps what was staged', async () => {
		const { host, session } = await started();
		await session.submit('/attach /tmp/one.png');
		host.attachFailure = 'Cannot read /tmp/two.png: no such file';
		await session.submit('/attach /tmp/two.png');
		expect(session.error).toMatch(/no such file/);
		expect(session.pendingRefs).toHaveLength(1);
	});
});
