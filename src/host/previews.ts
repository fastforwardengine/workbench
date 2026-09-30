import { type CommitUri, parseCommitUri, parseSnapshotUri } from '@ambionframework/ambion';
import type { GitCommit, Workspace } from '@ambionframework/workspace';
import { validRefName } from '@ambionframework/workspace/git';
import { isDatabase, readTables, tablesText } from '../view/database.ts';
import { type FileContent, imageMimeType, isImagePath, MAX_BYTES } from './files.ts';

/** How many leading bytes the panel reads to tell text from binary, as git does. */
const SNIFF_BYTES = 8000;

/** True when the first bytes hold a NUL. Git reads such a file as binary. */
const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, SNIFF_BYTES).includes(0);

/** A note when the panel shows no database or picture this large, or `undefined`. */
function tooLarge(bytes: Uint8Array, named: string): string | undefined {
	const kind = isDatabase(bytes) ? 'database' : isImagePath(named) ? 'picture' : undefined;
	if (kind === undefined) return undefined;
	const limit = kind === 'database' ? MAX_BYTES.database : MAX_BYTES.image;
	if (bytes.byteLength <= limit) return undefined;
	return `A ${kind} of ${bytes.byteLength} bytes. The preview shows one of up to ${limit / 1_048_576} MiB. An agent reads it with restore.`;
}

/**
 * The bytes of a snapshot ref, from the object store, as the panel shows
 * them: the tables of a SQLite database, a picture when the path that the file
 * had names one, a note for other binary bytes, and text otherwise. The
 * workspace checks the digest of the bytes.
 */
export async function readSnapshotFile(workspace: Workspace, ref: string): Promise<FileContent> {
	const bytes = await workspace.readSnapshot(ref);
	const named = parseSnapshotUri(ref)?.path ?? ref;
	const large = tooLarge(bytes, named);
	if (large) return note(ref, large);
	if (isDatabase(bytes)) {
		const tables = await readTables(bytes);
		return { path: ref, text: tablesText(tables), truncated: false, tables };
	}
	if (isImagePath(named)) {
		return {
			path: ref,
			text: '',
			truncated: false,
			image: { data: bytes, mimeType: imageMimeType(named) },
		};
	}
	if (isBinary(bytes))
		return note(ref, `A binary file of ${bytes.byteLength} bytes. An agent reads it with restore.`);
	const text = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES.text));
	return { path: ref, text, truncated: bytes.byteLength > MAX_BYTES.text };
}

const note = (path: string, text: string): FileContent => ({ path, text, truncated: false });

/** How the panel names a change: the letter of `git diff-tree --name-status`. */
const LETTER = { added: 'A', modified: 'M', deleted: 'D' } as const;

/** The lines of one commit, in the order of `git show --stat`. */
function commitLines(named: CommitUri, commit: GitCommit): string[] {
	const via =
		named.branch === undefined ? named.tag && `tag ${named.tag}` : `branch ${named.branch}`;
	const parents = commit.parents.length === 0 ? 'none: a root commit' : commit.parents.join(', ');
	return [
		via === undefined ? named.repository : `${named.repository}, ${via}`,
		`commit ${commit.hash}`,
		`Author: ${commit.author.name} <${commit.author.email}>`,
		`Date:   ${commit.author.date}`,
		`Parent: ${parents}`,
		'',
		...commit.message
			.trimEnd()
			.split('\n')
			.map((line) => `    ${line}`),
		'',
		`Changes (${commit.changes.length}):`,
		...commit.changes.map((entry) => `  ${LETTER[entry.change]} ${entry.path}`),
	];
}

/**
 * Where the branch or the tag of a commit ref points now: at the commit, at
 * another commit, or at nothing. A ref with neither gives nothing.
 */
async function nowLine(workspace: Workspace, named: CommitUri): Promise<string | undefined> {
	const name = named.branch ?? named.tag;
	const git = workspace.git;
	if (name === undefined || git === undefined) return undefined;
	const at = named.branch === undefined ? { tag: name } : { branch: name };
	const label = `The ${named.branch === undefined ? 'tag' : 'branch'} ${name}`;
	// An agent writes the ref, so its name can be one that git refuses. The commit still shows.
	if (!validRefName(name))
		return `${label} is not a name that git accepts. The ref keeps this commit.`;
	const now = await git.use(workspace.host, (env) => env.resolve(named.repository, at));
	if (now === undefined) return `${label} no longer exists. The ref keeps this commit.`;
	return now === named.commit
		? `${label} still names this commit.`
		: `${label} now names ${now.slice(0, 7)}. The ref keeps this commit.`;
}

/**
 * The commit that a commit ref names, as the panel shows it: the repository
 * and the name that the ref records, the hash, the author, the parents, the
 * message, the changed paths, and where the branch or the tag points now.
 */
export async function readCommitFile(workspace: Workspace, ref: string): Promise<FileContent> {
	const named = parseCommitUri(ref);
	if (named === undefined) throw new Error(`${ref} is not a commit ref.`);
	const commit = await workspace.readCommit(ref);
	const now = await nowLine(workspace, named);
	const lines = [...commitLines(named, commit), ...(now === undefined ? [] : ['', now])];
	return { path: ref, text: lines.join('\n'), truncated: false };
}
