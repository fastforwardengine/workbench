import { type CommitUri, parseCommitUri, parseSnapshotUri } from '@ambionframework/ambion';
import type { GitCommit, Workspace } from '@ambionframework/workspace';
import { validRefName } from '@ambionframework/workspace/git';
import { isDatabase, readTables, tablesText } from '../view/database.ts';
import { type ManifestFrame, parseManifestFrames } from '../view/manifest.ts';
import {
	type FileContent,
	type FrameContent,
	imageMimeType,
	isImagePath,
	MAX_BYTES,
} from './files.ts';

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
	return `A ${kind} of ${bytes.byteLength} bytes. The preview shows one of up to ${limit / 1_048_576} MiB. A specialist reads it with restore.`;
}

/** The bytes that the panel reads for all frames of one manifest. */
const FRAME_BUDGET = MAX_BYTES.image;

/**
 * The frames of a sensor manifest, read one at a time in order. The host
 * reads each ref once, skips a frame that it cannot read, and stops when the
 * bytes pass the budget.
 */
async function readFrames(
	workspace: Workspace,
	sensor: string,
	frames: readonly ManifestFrame[],
): Promise<FrameContent[]> {
	const read = new Map<string, Uint8Array>();
	const out: FrameContent[] = [];
	let total = 0;
	for (const frame of frames) {
		let data = read.get(frame.ref);
		if (data === undefined) {
			data = await workspace.readSnapshot(frame.ref).catch(() => undefined);
			if (data === undefined) continue;
			total += data.byteLength;
			if (total > FRAME_BUDGET) break;
			read.set(frame.ref, data);
		}
		out.push({ image: { data, mimeType: frame.mediaType }, caption: `${sensor} · ${frame.at}` });
	}
	return out;
}

/** The frames of a sensor manifest, or `undefined` when it holds no frame that reads. */
async function readManifest(
	workspace: Workspace,
	ref: string,
	bytes: Uint8Array,
): Promise<FileContent | undefined> {
	const manifest = parseManifestFrames(bytes);
	if (manifest === undefined || manifest.frames.length === 0) return undefined;
	const frames = await readFrames(workspace, manifest.sensor, manifest.frames);
	if (frames.length === 0) return undefined;
	const text = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES.text));
	return { path: ref, text, truncated: bytes.byteLength > MAX_BYTES.text, frames };
}

/**
 * The bytes of a snapshot ref, from the object store, as the panel shows
 * them: the frames of a sensor manifest, the tables of a SQLite database, a
 * picture when the path that the file had names one, a note for other binary
 * bytes, and text otherwise. The workspace checks the digest of the bytes.
 */
export async function readSnapshotFile(workspace: Workspace, ref: string): Promise<FileContent> {
	const bytes = await workspace.readSnapshot(ref);
	const named = parseSnapshotUri(ref)?.path ?? ref;
	const large = tooLarge(bytes, named);
	if (large) return note(ref, large);
	if (named.endsWith('manifest.json')) {
		const manifest = await readManifest(workspace, ref, bytes);
		if (manifest) return manifest;
	}
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
		return note(
			ref,
			`A binary file of ${bytes.byteLength} bytes. A specialist reads it with restore.`,
		);
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
	// A seat writes the ref, so its name can be one that git refuses. The commit still shows.
	if (!validRefName(name))
		return `${label} is not a name that git accepts. The ref keeps this commit.`;
	const now = await git.use(workspace.mirrorAgent, (env) => env.resolve(named.repository, at));
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
