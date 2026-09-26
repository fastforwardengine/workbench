import { BACKGROUND_CONTEXT, type Workspace } from '@ambionframework/workspace';
import {
	isDatabase,
	isDatabasePath,
	readTables,
	type TableView,
	tablesText,
} from '../view/database.ts';
import { fail } from './rooms.ts';

export type { TableView };

/** One file of the workspace. */
export interface FileEntry {
	path: string;
	size: number;
}

/** One file: its text, or for a SQLite database its tables, with a text copy in `text`. */
export interface FileContent {
	path: string;
	text: string;
	truncated: boolean;
	tables?: TableView[];
}

/** The environment of one workspace operation. */
type Env = Parameters<Parameters<Workspace['use']>[1]>[0];

/**
 * The files and the folders of one folder. A root must list. A folder below
 * a root that the host account cannot read, such as a folder of mode 0700 on
 * a workstation, gives nothing.
 */
async function listFolder(env: Env, folder: string, root: boolean) {
	const result = await env.listDir(folder, BACKGROUND_CONTEXT);
	if (!result.ok && root) throw result.error;
	return result.ok ? result.value : [];
}

/**
 * The files under `roots`, as the host account reads them, up to 500
 * entries. A local directory lists `/`. A workstation lists its shared
 * folders, because each home has mode 0700.
 */
export async function listFiles(
	workspace: Workspace,
	roots: readonly string[],
): Promise<FileEntry[]> {
	return workspace.use(workspace.host, async (env) => {
		const files: FileEntry[] = [];
		const pending = [...roots];
		let visited = 0;
		while (pending.length > 0 && visited < 500) {
			const folder = pending.shift() ?? '/';
			const entries = (await listFolder(env, folder, roots.includes(folder))).slice(
				0,
				500 - visited,
			);
			visited += entries.length;
			files.push(
				...entries
					.filter((entry) => entry.kind === 'file')
					.map(({ path, size }) => ({ path, size })),
			);
			pending.push(
				...entries
					// Virtual shell devices are infrastructure, not project artifacts.
					.filter((entry) => entry.kind === 'directory' && entry.path !== '/dev')
					.map((entry) => entry.path),
			);
		}
		return files.sort((a, b) => a.path.localeCompare(b.path));
	});
}

export async function readFile(workspace: Workspace, path: string): Promise<FileContent> {
	const parts = path.split('/').slice(1);
	if (
		!path.startsWith('/') ||
		parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
	) {
		fail('Use an absolute workspace file path.');
	}
	return workspace.use(workspace.host, async (env) => {
		let prefix = '';
		for (const part of parts) {
			prefix += `/${part}`;
			const info = await env.fileInfo(prefix, BACKGROUND_CONTEXT);
			if (!info.ok) fail('File not found.');
			checkFile(info.value, isDatabasePath(path));
		}
		if (isDatabasePath(path)) return readDatabase(env, path);
		const result = await env.readTextFile(path, BACKGROUND_CONTEXT);
		if (!result.ok) fail(result.error.message);
		return { path, text: result.value, truncated: false };
	});
}

function checkFile(info: { kind: string; size: number }, database: boolean): void {
	if (info.kind === 'symlink') fail('The file browser does not follow symbolic links.');
	if (info.kind !== 'file') return;
	if (database && info.size > MAX_DATABASE) fail('Preview supports databases up to 8 MiB.');
	if (!database && info.size > MAX_TEXT) fail('Preview supports files up to 128 KiB.');
}

const MAX_TEXT = 131_072;
const MAX_DATABASE = 8_388_608;

interface Reader {
	readBinaryFile(
		path: string,
		context: typeof BACKGROUND_CONTEXT,
	): Promise<{ ok: true; value: Uint8Array } | { ok: false; error: { message: string } }>;
}

async function readDatabase(env: Reader, path: string): Promise<FileContent> {
	const result = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
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
