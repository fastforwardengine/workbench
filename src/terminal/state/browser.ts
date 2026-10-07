import { parseCommitUri, parseSnapshotUri } from '@ambionframework/ambion';
import type { FileContent, FileEntry, Lab } from '../../host/host.ts';
import type { CitedFile } from '../../view/refs.ts';

/** How the panel loads one entry: a snapshot ref, a commit ref, or a path of the workspace. */
export function entryLoader(host: Lab): (path: string) => Promise<FileContent> {
	return (path) => {
		if (parseSnapshotUri(path) !== undefined) return host.snapshot(path);
		if (parseCommitUri(path) !== undefined) return host.commit(path);
		return host.file(path);
	};
}

/** The heading of the rows that the open room cites. */
export const CITED_HEAD = 'Cited here';

/** One row of the files layer. */
export interface FileRow {
	/** `cited` for a row of the section at the head, `file` for a file of the workspace. */
	kind: 'cited' | 'file';
	/** What the preview loads: a workspace path, a snapshot ref, or a commit ref. */
	path: string;
	/** What the row shows: a path inside its group, or the name of a commit. */
	label: string;
	/** The heading above the row. It is empty for a file that the host listed with no group. */
	group: string;
	/** The size of a file of the workspace. */
	size?: number;
	/** The newest citation of the file by the open room. */
	cite?: CitedFile;
}

/** The row of the section at the head. */
const citedRow = (cite: CitedFile): FileRow => ({
	kind: 'cited',
	path: cite.open,
	label: cite.label,
	group: CITED_HEAD,
	cite,
});

/** The row of a file of the workspace, with the citation of its path when the room cites it. */
const fileRow = (file: FileEntry, cite: CitedFile | undefined): FileRow => ({
	kind: 'file',
	path: file.path,
	label: file.relative ?? file.path,
	group: file.group ?? '',
	size: file.size,
	cite,
});

/** The rows of the layer: what the room cites, then the files of the workspace in the order the host lists them. */
function buildRows(files: readonly FileEntry[], cited: readonly CitedFile[]): FileRow[] {
	const byKey = new Map(cited.map((cite) => [cite.key, cite]));
	return [...cited.map(citedRow), ...files.map((file) => fileRow(file, byKey.get(file.path)))];
}

/** The text of a row that the search reads: the whole path of a file, and the name of a cited row. */
const haystack = (row: FileRow): string => (row.kind === 'cited' ? row.label : row.path);

/** The rows whose text holds every word of the query, in their order. */
function matchRows(rows: readonly FileRow[], query: string): FileRow[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return rows.filter((row) => words.every((word) => haystack(row).toLowerCase().includes(word)));
}

/**
 * Where `show` starts: the row that opens the path, else the row that cites the path
 * as an older version, else the first row. An older version takes the row of its file
 * and opens in it.
 */
function startAt(rows: FileRow[], path: string | undefined): number {
	const exact = rows.findIndex((row) => row.path === path);
	if (exact >= 0 || path === undefined) return Math.max(0, exact);
	const older = rows.findIndex((row) => row.cite?.opens.includes(path));
	const row = rows[older];
	if (row) rows[older] = { ...row, path };
	return Math.max(0, older);
}

/**
 * The files panel, without drawing: a search box, the rows that match it, and the
 * row the person chose. The rows are the files that the open room cites, then the
 * files of the workspace by group. The chosen file loads as the selection moves.
 */
export class FileBrowser {
	open = false;
	query = '';
	index = 0;
	/** The chosen file, once it loads. */
	file: FileContent | undefined;
	/** Why the chosen file did not load. */
	problem: string | undefined;
	/** The table of a database that the panel shows. */
	tab = 0;
	/** What the status line says after a key that did nothing, such as Enter on a file that no message cites. */
	notice: string | undefined;
	private rows: FileRow[] = [];
	private token = 0;
	private readonly load: (path: string) => Promise<FileContent>;
	private readonly changed: () => void;

	constructor(load: (path: string) => Promise<FileContent>, changed: () => void) {
		this.load = load;
		this.changed = changed;
	}

	get matches(): FileRow[] {
		return matchRows(this.rows, this.query);
	}

	get selected(): FileRow | undefined {
		return this.matches[this.index];
	}

	get total(): number {
		return this.rows.length;
	}

	/** How many rows the section at the head holds. */
	get cited(): number {
		return this.rows.filter((row) => row.kind === 'cited').length;
	}

	/** The seq of the newest message that cites the chosen file, or undefined when none does. */
	get citedBy(): number | undefined {
		return this.selected?.cite?.seq;
	}

	/**
	 * Open the panel on these files and on what the room cites, with one row chosen
	 * when the path is known. A path of an older snapshot opens in the row of its file.
	 */
	show(files: readonly FileEntry[], path?: string, cited: readonly CitedFile[] = []): void {
		this.rows = buildRows(files, cited);
		this.query = '';
		this.notice = undefined;
		this.index = startAt(this.rows, path);
		this.open = true;
		void this.preview();
	}

	/** Say something in the status line until the next key. */
	tell(text: string): void {
		this.notice = text;
		this.changed();
	}

	hide(): void {
		this.open = false;
		this.token += 1;
		this.changed();
	}

	/** Open the panel again on the state that `hide` left, and read the chosen file again when it did not arrive. */
	resume(): void {
		this.open = true;
		void this.preview();
	}

	type(text: string): void {
		this.query += text;
		this.refilter();
	}

	backspace(): void {
		this.query = this.query.slice(0, -1);
		this.refilter();
	}

	clear(): void {
		this.query = '';
		this.refilter();
	}

	/** Show another table of the chosen database. */
	moveTab(step: number): void {
		const count = this.file?.tables?.length ?? 0;
		if (count === 0) return;
		this.tab = Math.max(0, Math.min(count - 1, this.tab + step));
		this.changed();
	}

	move(step: number): void {
		const last = this.matches.length - 1;
		if (last < 0) return;
		this.index = Math.max(0, Math.min(last, this.index + step));
		void this.preview();
	}

	private refilter(): void {
		this.index = 0;
		void this.preview();
	}

	private async preview(): Promise<void> {
		this.token += 1;
		const mine = this.token;
		const entry = this.selected;
		this.problem = undefined;
		if (!entry) this.file = undefined;
		else if (this.file?.path !== entry.path) await this.read(entry.path, mine);
		this.changed();
	}

	private async read(path: string, mine: number): Promise<void> {
		try {
			const file = await this.load(path);
			if (mine !== this.token) return;
			this.file = file;
			// Start on the first table that holds rows.
			this.tab = Math.max(0, file.tables?.findIndex((table) => table.count > 0) ?? 0);
		} catch (error) {
			if (mine !== this.token) return;
			this.file = undefined;
			this.problem = error instanceof Error ? error.message : String(error);
		}
	}
}
