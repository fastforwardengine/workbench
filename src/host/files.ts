import { readFile as readLocalFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { snapshotUri } from '@ambionframework/ambion';
import type { Workspace } from '@ambionframework/workspace';
import {
	isDatabase,
	isDatabasePath,
	readTables,
	type TableView,
	tablesText,
} from '../view/database.ts';
import { WORKSPACE } from '../view/refs.ts';
import { fail } from './rooms.ts';

export type { TableView };

/** Where an attached local file lands in the workspace. */
const ATTACHMENTS_DIR = '/attachments';

/** The extensions that the panel previews as a picture, and the type that each names. */
const IMAGE_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

export const isImagePath = (path: string): boolean =>
	Object.keys(IMAGE_TYPES).some((extension) => path.toLowerCase().endsWith(extension));

export function imageMimeType(path: string): string {
	const extension = Object.keys(IMAGE_TYPES).find((one) => path.toLowerCase().endsWith(one));
	return (extension && IMAGE_TYPES[extension]) ?? 'application/octet-stream';
}

/** One file of the workspace. */
export interface FileEntry {
	path: string;
	size: number;
	/**
	 * The heading that the list puts the file under: a root such as `/shared`, or a
	 * home such as `~engineer`. A snapshot or a commit has none.
	 */
	group?: string;
	/** The path of the file inside its group. */
	relative?: string;
	/** A snapshot or a commit that the panel lists for a ref. A file of the workspace has none. */
	kind?: 'snapshot' | 'commit';
	/** What the list shows in place of the path, for a snapshot or a commit. */
	label?: string;
}

/** One picture, as the panel renders it: its bytes and the type that they decode as. */
export interface ImageContent {
	data: Uint8Array;
	mimeType: string;
}

/** One file: its text, or for a SQLite database its tables, with a text copy in `text`. */
export interface FileContent {
	path: string;
	text: string;
	truncated: boolean;
	tables?: TableView[];
	/** Set in place of `text` for a file that the panel previews as a picture. */
	image?: ImageContent;
}

/** The environment of one workspace operation. */
type Env = Parameters<Parameters<Workspace['use']>[1]>[0];

/**
 * The files and the folders of one folder. A root must list. A folder below
 * a root that the host account cannot read, such as a folder of mode 0700 on
 * a workstation, gives nothing.
 */
async function listFolder(env: Env, folder: string, root: boolean) {
	const result = await env.listDir(folder);
	if (!result.ok && root) throw result.error;
	return result.ok ? result.value : [];
}

/** The folder that holds the homes of the seats, on a workstation and on a local directory. */
const HOMES = '/home';

/** The home of a seat. */
const homeOf = (seat: string): string => `${HOMES}/${seat}`;

/** The most entries that the walk of the roots reads. */
const ROOT_ENTRIES = 500;

/** The most files that the list takes from the home of one seat. */
const HOME_FILES = 200;

/** The most entries that one home lists before it stops, so a large clone does not hold the list. */
const HOME_VISITS = 1_000;

/**
 * The heading of a file below a root. The root `/` of a local directory has no
 * heading of its own, so the top folder of the file names its group.
 */
function groupOf(path: string, root: string): string {
	if (root !== '/') return root;
	const parts = path.split('/');
	return parts.length > 2 ? `/${parts[1]}` : '/';
}

/** A file below a root, with its group and its path inside the group. */
function rootEntry(path: string, size: number, root: string): FileEntry {
	const group = groupOf(path, root);
	return { path, size, group, relative: path.slice(group === '/' ? 1 : group.length + 1) };
}

/** A folder to walk, and the root that it lies under. */
interface Walk {
	folder: string;
	root: string;
}

/** What a listing says of one entry. */
interface Listed {
	kind: string;
	path: string;
	size: number;
}

const byPath = (a: FileEntry, b: FileEntry): number => a.path.localeCompare(b.path);

/**
 * The files below a root that a listing holds, and the folders to walk next. The
 * walk leaves out `/dev`, where the shell keeps its virtual devices, and each
 * folder in `skipped`.
 */
function intake(entries: readonly Listed[], root: string, skipped: ReadonlySet<string>) {
	return {
		files: entries
			.filter((entry) => entry.kind === 'file')
			.map((entry) => rootEntry(entry.path, entry.size, root)),
		folders: entries
			.filter((entry) => entry.kind === 'directory')
			.filter((entry) => entry.path !== '/dev' && !skipped.has(entry.path))
			.map((entry): Walk => ({ folder: entry.path, root })),
	};
}

/**
 * The files under `roots`, up to 500 entries read, in the order of the roots and
 * then by path. A folder in `skipped` stays out of the walk.
 */
async function listRoots(env: Env, roots: readonly string[], skipped: ReadonlySet<string>) {
	const found = new Map<string, FileEntry[]>(roots.map((root) => [root, []]));
	const pending: Walk[] = roots.map((root) => ({ folder: root, root }));
	let visited = 0;
	for (let walk = pending.shift(); walk && visited < ROOT_ENTRIES; walk = pending.shift()) {
		const listed = await listFolder(env, walk.folder, walk.folder === walk.root);
		const entries = listed.slice(0, ROOT_ENTRIES - visited);
		visited += entries.length;
		const taken = intake(entries, walk.root, skipped);
		found.get(walk.root)?.push(...taken.files);
		pending.push(...taken.folders);
	}
	return [...found.values()].flatMap((files) => files.sort(byPath));
}

/** A name that starts with a dot: a hidden file, or a folder such as `.git` or `.cache`. */
const hidden = (path: string): boolean => path.split('/').pop()?.startsWith('.') ?? false;

/** Walk the home of a seat as that seat: up to 200 files, and no hidden file or folder. */
async function walkHome(env: Env, seat: string): Promise<FileEntry[]> {
	const home = homeOf(seat);
	const files: FileEntry[] = [];
	const pending = [home];
	let visited = 0;
	for (let folder = pending.shift(); folder !== undefined; folder = pending.shift()) {
		const listed = await env.listDir(folder);
		const entries = (listed.ok ? listed.value : []).filter((entry) => !hidden(entry.path));
		visited += entries.length;
		files.push(
			...entries
				.filter((entry) => entry.kind === 'file')
				.map(({ path, size }) => ({
					path,
					size,
					group: `~${seat}`,
					relative: path.slice(home.length + 1),
				})),
		);
		pending.push(...entries.filter((entry) => entry.kind === 'directory').map((e) => e.path));
		if (files.length >= HOME_FILES || visited >= HOME_VISITS) break;
	}
	return files.sort(byPath).slice(0, HOME_FILES);
}

/**
 * The files in the home of one seat, read as that seat. A home that fails to
 * list gives an empty group, so one seat does not fail the whole list.
 */
async function listHome(workspace: Workspace, seat: string): Promise<FileEntry[]> {
	try {
		return await workspace.use({ name: seat }, (env) => walkHome(env, seat));
	} catch {
		return [];
	}
}

/**
 * The files of the workspace: those under `roots`, as the host account reads
 * them, up to 500 entries. With `homes`, the home of each seat in `seats` follows,
 * read as that seat, up to 200 files for each home, one seat after the other. A
 * local directory lists `/`, and its walk always leaves the homes to the seats.
 * A workstation lists its shared folders, because each home has mode 0700 and
 * only its seat reads it.
 */
export async function listFiles(
	workspace: Workspace,
	roots: readonly string[],
	seats: readonly string[] = [],
	homes = true,
): Promise<FileEntry[]> {
	const skipped = new Set(seats.map(homeOf));
	const files = await workspace.use(workspace.mirrorAgent, (env) => listRoots(env, roots, skipped));
	if (!homes) return files;
	for (const seat of seats) files.push(...(await listHome(workspace, seat)));
	return files;
}

/** What the panel previews a file as. */
type Kind = 'text' | 'database' | 'image';

/** The most bytes that the panel previews, by kind, and what it tells the person past that. */
export const MAX_BYTES: Record<Kind, number> = {
	text: 131_072,
	database: 8_388_608,
	image: 8_388_608,
};
const SIZE_ADVICE: Record<Kind, string> = {
	text: 'Preview supports files up to 128 KiB.',
	database: 'Preview supports databases up to 8 MiB.',
	image: 'Preview supports pictures up to 8 MiB.',
};

const kindOf = (path: string): Kind =>
	isDatabasePath(path) ? 'database' : isImagePath(path) ? 'image' : 'text';

/** The agent that reads a path: the seat that owns the home the path lies in, else the host account. */
function ownerOf(workspace: Workspace, path: string, seats: readonly string[]) {
	const seat = seats.find((name) => path.startsWith(`${homeOf(name)}/`));
	return seat === undefined ? workspace.mirrorAgent : { name: seat };
}

/** The list leaves out the hidden files of a home, such as `.ssh`, and a read refuses them too. */
function refuseHidden(path: string, seats: readonly string[]): void {
	const seat = seats.find((name) => path.startsWith(`${homeOf(name)}/`));
	if (seat === undefined) return;
	const inside = path.slice(homeOf(seat).length + 1).split('/');
	if (inside.some((part) => part.startsWith('.')))
		fail('The file browser does not read hidden files in a home.');
}

/** Read one file. A file in the home of a seat of `seats` reads as that seat. */
export async function readFile(
	workspace: Workspace,
	path: string,
	seats: readonly string[] = [],
): Promise<FileContent> {
	const parts = path.split('/').slice(1);
	if (
		!path.startsWith('/') ||
		parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
	) {
		fail('Use an absolute workspace file path.');
	}
	const kind = kindOf(path);
	refuseHidden(path, seats);
	return workspace.use(ownerOf(workspace, path, seats), async (env) => {
		await checkAncestors(env, parts, kind);
		return readAs(env, path, kind);
	});
}

/** Every part of the path must be a plain file or folder, and small enough for the preview. */
async function checkAncestors(env: Env, parts: readonly string[], kind: Kind): Promise<void> {
	let prefix = '';
	for (const part of parts) {
		prefix += `/${part}`;
		const info = await env.fileInfo(prefix);
		if (!info.ok) fail('File not found.');
		checkFile(info.value, kind);
	}
}

/** Read the file the way its kind shows: as a database, a picture, or text. */
async function readAs(env: Env, path: string, kind: Kind): Promise<FileContent> {
	if (kind === 'database') return readDatabase(env, path);
	if (kind === 'image') return readImage(env, path);
	const result = await env.readTextFile(path);
	if (!result.ok) fail(result.error.message);
	return { path, text: result.value, truncated: false };
}

function checkFile(info: { kind: string; size: number }, kind: Kind): void {
	if (info.kind === 'symlink') fail('The file browser does not follow symbolic links.');
	if (info.kind !== 'file') return;
	if (info.size > MAX_BYTES[kind]) fail(SIZE_ADVICE[kind]);
}

interface Reader {
	readBinaryFile(
		path: string,
		signal?: AbortSignal,
	): Promise<{ ok: true; value: Uint8Array } | { ok: false; error: { message: string } }>;
}

async function readDatabase(env: Reader, path: string): Promise<FileContent> {
	const result = await env.readBinaryFile(path);
	if (!result.ok) return fail(result.error.message);
	if (!isDatabase(result.value)) return fail('This file is not a SQLite database.');
	try {
		const tables = await readTables(result.value);
		return { path, text: tablesText(tables), truncated: false, tables };
	} catch (error) {
		return fail(
			`Cannot read this database: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readImage(env: Reader, path: string): Promise<FileContent> {
	const result = await env.readBinaryFile(path);
	if (!result.ok) return fail(result.error.message);
	return {
		path,
		text: '',
		truncated: false,
		image: { data: result.value, mimeType: imageMimeType(path) },
	};
}

/** One attached file: where it landed, its size, and the snapshot ref that cites it. */
export interface Attachment extends FileEntry {
	ref: string;
}

/** A path as a message shows it: a control character, such as a newline in a name, becomes a `?`. */
const printable = (path: string): string =>
	Array.from(path, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? '?' : char;
	}).join('');

/** A read of the person's own disk, with the failure said in one line. */
async function readLocal<T>(read: () => Promise<T>, localPath: string): Promise<T> {
	try {
		return await read();
	} catch (error) {
		return fail(
			`Cannot read ${printable(localPath)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The path in the attachments folder for a name, with a number added when the name is taken. */
async function freeName(env: Env, name: string): Promise<string> {
	for (let taken = 0; ; taken += 1) {
		const path = `${ATTACHMENTS_DIR}/${taken === 0 ? name : `${taken + 1}-${name}`}`;
		const found = await env.exists(path);
		if (found.ok && !found.value) return path;
		if (!found.ok) fail(found.error.message);
	}
}

/**
 * Copy a local file into the workspace, and snapshot it, so a message cites the
 * bytes that the person attached. The name keeps the file's own name, prefixed
 * with the time it landed, and a number when that name is taken, so two files
 * of one name never overwrite each other. The size is checked before the read,
 * so a file that is too large is never buffered.
 */
export async function attachFile(workspace: Workspace, localPath: string): Promise<Attachment> {
	const resolved = localPath.startsWith('~/') ? join(homedir(), localPath.slice(2)) : localPath;
	const info = await readLocal(() => stat(resolved), localPath);
	// A pipe or a device reports a size of 0 and never ends, so only a regular file is read.
	if (!info.isFile()) fail(`Cannot attach ${printable(localPath)}: it is not a regular file.`);
	if (info.size > MAX_BYTES.image)
		fail(`/attach takes files up to ${MAX_BYTES.image / 1_048_576} MiB.`);
	const name = `${Date.now()}-${basename(resolved)}`;
	checkCitable(`${ATTACHMENTS_DIR}/${name}`, localPath);
	const bytes = await readLocal(() => readLocalFile(resolved), localPath);
	// The file can grow between the stat and the read.
	if (bytes.length > MAX_BYTES.image)
		fail(`/attach takes files up to ${MAX_BYTES.image / 1_048_576} MiB.`);
	const path = await workspace.use(workspace.mirrorAgent, async (env) => {
		const made = await env.createDir(ATTACHMENTS_DIR, { recursive: true });
		if (!made.ok)
			fail(
				`The workspace has no ${ATTACHMENTS_DIR} folder to write to (${made.error.message}). On a workstation, run make workstation again.`,
			);
		const free = await freeName(env, name);
		const written = await env.writeFile(free, bytes);
		if (!written.ok) fail(written.error.message);
		return free;
	});
	return snapshotCopy(workspace, path, bytes.length);
}

/** Refuse a name that a snapshot ref cannot hold, before anything is written. */
function checkCitable(path: string, localPath: string): void {
	try {
		snapshotUri(WORKSPACE, '0'.repeat(64), path);
	} catch {
		fail(`Cannot attach ${printable(localPath)}: its name is not one that a ref can hold.`);
	}
}

/** Snapshot the copy. When that fails, the copy goes, so no file stays in the folder unciteable. */
async function snapshotCopy(workspace: Workspace, path: string, size: number): Promise<Attachment> {
	try {
		const [ref] = await workspace.snapshot([path]);
		if (ref !== undefined) return { path, size, ref };
	} catch (error) {
		await removeCopy(workspace, path);
		return fail(
			`Cannot snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	await removeCopy(workspace, path);
	return fail(`No snapshot of ${path}.`);
}

async function removeCopy(workspace: Workspace, path: string): Promise<void> {
	await workspace.use(workspace.mirrorAgent, (env) => env.remove(path, { recursive: false }));
}
