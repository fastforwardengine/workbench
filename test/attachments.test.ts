import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachFile, imageMimeType, isImagePath } from '../src/host/files.ts';
import { readSnapshotFile } from '../src/host/previews.ts';
import {
	attachCommand,
	attachmentNote,
	pastedImagePath,
	type StagedAttachment,
	stagedCue,
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
			expect(second.path).toMatch(/^\/attachments\/2-\d+-a\.png$/);
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
			await expect(attachFile(workspace, dir)).rejects.toThrow(/it is not a regular file/);
			await expect(attachFile(workspace, join(dir, 'big.png'))).rejects.toThrow(
				'/attach takes files up to 8 MiB.',
			);
		} finally {
			await workspace.dispose();
		}
	});

	it('gives the panel a picture for the snapshot of a picture', async () => {
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

describe('attachFile, with files that it must refuse', () => {
	const open3 = () => openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });

	/** The names in /attachments, or none when the folder does not exist. */
	async function attached(workspace: ReturnType<typeof open3>): Promise<string[]> {
		return workspace.use(workspace.host, async (env) => {
			const listed = await env.listDir('/attachments', BACKGROUND_CONTEXT);
			return listed.ok ? listed.value.map((entry) => entry.path) : [];
		});
	}

	it('refuses a pipe at once, and never waits for it to end', async () => {
		const dir = await folder();
		const pipe = join(dir, 'frame.png');
		execFileSync('mkfifo', [pipe]);
		const workspace = open3();
		try {
			await expect(attachFile(workspace, pipe)).rejects.toThrow(/it is not a regular file/);
			await expect(attachFile(workspace, dir)).rejects.toThrow(/it is not a regular file/);
			expect(await attached(workspace)).toEqual([]);
		} finally {
			await workspace.dispose();
		}
	}, 10_000);

	it('refuses a name that a ref cannot hold, in one line, and writes nothing', async () => {
		const dir = await folder();
		const odd = join(dir, 'bench\nphoto.png');
		await writeFile(odd, PNG);
		const workspace = open3();
		try {
			await expect(attachFile(workspace, odd)).rejects.toThrow(
				/^Cannot attach .*: its name is not one that a ref can hold\.$/,
			);
			expect(await attached(workspace)).toEqual([]);
		} finally {
			await workspace.dispose();
		}
	});

	it('removes the copy when the snapshot fails, and says why', async () => {
		const dir = await folder();
		await writeFile(join(dir, 'a.png'), PNG);
		const workspace = open3();
		// The workspace is frozen, so a child that shadows `snapshot` stands in for a store that is down.
		const failing = Object.create(workspace) as typeof workspace;
		Object.defineProperty(failing, 'snapshot', {
			value: async () => {
				throw new Error('the store is down');
			},
		});
		try {
			await expect(attachFile(failing, join(dir, 'a.png'))).rejects.toThrow(
				/^Cannot snapshot \/attachments\/\d+-a\.png: the store is down$/,
			);
			expect(await attached(workspace)).toEqual([]);
		} finally {
			await workspace.dispose();
		}
	});

	it('tells the person what to do when the workspace has no attachments folder', async () => {
		const dir = await folder();
		await writeFile(join(dir, 'a.png'), PNG);
		const workspace = open3();
		await workspace.use(workspace.host, (env) =>
			env.writeFile('/attachments', 'a file where the folder should be', BACKGROUND_CONTEXT),
		);
		try {
			await expect(attachFile(workspace, join(dir, 'a.png'))).rejects.toThrow(
				/no \/attachments folder to write to .*run make workstation again/,
			);
		} finally {
			await workspace.dispose();
		}
	});

	it('gives the panel a note, and no bytes, for a snapshot of a picture or a database over 8 MiB', async () => {
		const workspace = open3();
		try {
			const over = 8 * 1_048_576 + 1;
			const database = Buffer.alloc(over);
			database.write('SQLite format 3\0');
			await workspace.use(workspace.host, async (env) => {
				await env.writeFile('/shared/big.png', Buffer.alloc(over, 1), BACKGROUND_CONTEXT);
				await env.writeFile('/shared/big.db', database, BACKGROUND_CONTEXT);
			});
			const [picture, table] = await workspace.snapshot(['/shared/big.png', '/shared/big.db']);
			const shownPicture = await readSnapshotFile(workspace, picture ?? '');
			const shownTable = await readSnapshotFile(workspace, table ?? '');
			expect(shownPicture.image).toBeUndefined();
			expect(shownPicture.text).toMatch(
				/^A picture of 8388609 bytes\. The preview shows one of up to 8 MiB/,
			);
			expect(shownTable.text).toMatch(
				/^A database of 8388609 bytes\. The preview shows one of up to 8 MiB/,
			);
		} finally {
			await workspace.dispose();
		}
	}, 20_000);
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

describe('attachCommand, at the limit of a message', () => {
	it('stages 16 files, and refuses the 17th before it copies anything', async () => {
		const host = new FakeHost();
		const staged = { pendingRefs: [] as StagedAttachment[] };
		for (let at = 0; at < 16; at += 1) await attachCommand(host, staged, `/tmp/pic-${at}.png`);
		expect(staged.pendingRefs).toHaveLength(16);
		const done = await attachCommand(host, staged, '/tmp/one-more.png');
		expect(done).toEqual({
			notice:
				'A message holds up to 16 attachments. Send this message first, then attach the rest.',
		});
		expect(staged.pendingRefs).toHaveLength(16);
		expect(host.attached).not.toContain('/tmp/one-more.png');
	});
});

const stagedOf = (...names: string[]): StagedAttachment[] =>
	names.map((name) => ({ path: `/attachments/${name}`, ref: `ambion://x/${name}` }));

describe('stagedCue', () => {
	it('says nothing when no file is staged', () => {
		expect(stagedCue([])).toBeUndefined();
	});

	it('names one file, and two, by their file names', () => {
		expect(stagedCue(stagedOf('1790741386233-board.png'))).toBe('1 attached: board.png');
		expect(stagedCue(stagedOf('a.png', 'b.jpg'))).toBe('2 attached: a.png, b.jpg');
	});

	it('names the first two and counts the rest', () => {
		expect(stagedCue(stagedOf('a.png', 'b.png', 'c.png', 'd.png'))).toBe(
			'4 attached: a.png, b.png +2',
		);
	});

	it('cuts a long file name to 24 cells', () => {
		const cue = stagedCue(stagedOf(`${'x'.repeat(40)}.png`)) ?? '';
		expect(cue).toBe(`1 attached: ${'x'.repeat(23)}…`);
	});
});

describe('attachmentNote', () => {
	it('names every staged file in one sentence, and is empty for none', () => {
		expect(attachmentNote(stagedOf('a.png', 'b.jpg'))).toBe('Attached a.png, b.jpg.');
		expect(attachmentNote([])).toBe('');
	});
});

describe('Session, with attachments', () => {
	it('sends the attachments alone on an empty composer, and clears them', async () => {
		const { host, session } = await started();
		await session.submit('/attach /tmp/one.png');
		host.calls.length = 0;
		await session.submit('');
		expect(host.calls).toEqual(['send:characterization:priya:Attached 1-one.png.']);
		expect(host.sentRefs).toHaveLength(1);
		expect(host.sentRefs[0]).toHaveLength(1);
		expect(session.pendingRefs).toEqual([]);
	});

	it('keeps the attachments staged when the send fails', async () => {
		const { host, session } = await started();
		await session.submit('/attach /tmp/one.png');
		host.failNext = 'offline';
		await session.submit('   ');
		expect(session.error).toBe('offline');
		expect(session.pendingRefs).toHaveLength(1);
	});

	it('sends nothing on an empty composer when nothing is staged', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('');
		expect(host.calls).toEqual([]);
	});

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

	it('keeps the files staged in a new room when a send of the old room ends after the switch', async () => {
		const { host, session } = await started();
		await session.submit('/attach /tmp/for-a.png');
		let release: () => void = () => {};
		host.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sending = session.submit('A question for room A.');
		await vi.waitFor(() => expect(session.pendingRefs).toHaveLength(1));
		await session.submit('/room budget');
		await session.submit('/attach /tmp/for-b.png');
		expect(session.pendingRefs.map((one) => one.path)).toEqual(['/attachments/1-for-b.png']);
		release();
		await sending;
		expect(session.pendingRefs.map((one) => one.path)).toEqual(['/attachments/1-for-b.png']);
		expect(host.sentRefs[0]).toHaveLength(1);
	});
});
