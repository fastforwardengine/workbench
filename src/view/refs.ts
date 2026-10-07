import type { Message, SaidMessage } from '@ambionframework/ambion';
import { parseCommitUri, parseRoomUri, parseSnapshotUri } from '@ambionframework/ambion';
import { ellipsize } from './text.ts';
import type { Block } from './timeline.ts';

/**
 * The refs of a message, as the terminal shows and opens them.
 *
 * A ref is untrusted text from a seat. The room stores it and never reads
 * behind it. The terminal chooses four forms and resolves each one against
 * a list the host gives, so no ref reaches a host file:
 *
 * - `file:///<path>` names a file of the workspace.
 * - `ambion://workspace/workbench/snapshot/<digest>/<path>` names the bytes
 *   that a file held at a snapshot. The panel shows them.
 * - `ambion://workspace/workbench/repo/<repository>/.../commit/<hash>` names
 *   a commit of a lab repository. The panel shows it.
 * - `ambion://room/<room>/message/<seq>` names a message of the open room.
 */

/** The name of the workspace of Workbench, the first part of each snapshot ref and commit ref. */
export const WORKSPACE = 'workbench';

const FILE_PREFIX = /^file:\/\/\/(.*)$/is;

/** What opening a resolved ref does. */
type RefTarget =
	| { kind: 'file'; path: string }
	| { kind: 'snapshot'; ref: string; label: string }
	| { kind: 'commit'; ref: string; label: string }
	| { kind: 'message'; seq: number };

/** What the terminal knows, to check a ref against. */
export interface Known {
	/** The open room. */
	room: string;
	/** The paths of the workspace files, as the host lists them. */
	files: readonly string[];
	/** The seqs of the messages read from the open room. */
	seqs: ReadonlySet<number>;
}

type RefKind = 'file' | 'snapshot' | 'commit' | 'message' | 'unknown';

/** One ref after resolution. `target` is absent when the ref does not resolve. */
export interface ResolvedRef {
	ref: string;
	kind: RefKind;
	/** What the chip shows for the ref. */
	label: string;
	target?: RefTarget;
	/** Why the ref does not resolve. */
	problem?: string;
}

/** One ref of one shown message. `id` names it across redraws. */
export interface RefItem {
	id: string;
	seq: number;
	resolved: ResolvedRef;
}

const unresolved = (ref: string, kind: RefKind, problem: string): ResolvedRef => ({
	ref,
	kind,
	label: ref,
	problem,
});

/**
 * The workspace path a `file:` ref names, or a reason it names none. The path
 * must be absolute and must hold no empty part, no `.` or `..`, no backslash,
 * and no NUL after decoding. A query or a fragment is dropped.
 */
function filePath(ref: string): { path: string } | { problem: string } {
	const match = FILE_PREFIX.exec(ref);
	if (!match) return { problem: 'use file:///<workspace path>' };
	let decoded: string;
	try {
		decoded = decodeURIComponent((match[1] ?? '').split(/[?#]/)[0] ?? '');
	} catch {
		return { problem: 'the path is not valid' };
	}
	const bad = decoded
		.split('/')
		.some((part) => part === '' || part === '.' || part === '..' || /[\\\0]/.test(part));
	if (bad) return { problem: 'the path is not a workspace path' };
	return { path: `/${decoded}` };
}

function resolveFile(ref: string, known: Known): ResolvedRef {
	const named = filePath(ref);
	if ('problem' in named) return unresolved(ref, 'file', named.problem);
	if (!known.files.includes(named.path)) return unresolved(ref, 'file', 'not in the workspace');
	return { ref, kind: 'file', label: named.path, target: { kind: 'file', path: named.path } };
}

/**
 * A snapshot of this workspace opens from the object store. The label is the
 * path that the file had, and the first digits of the digest tell two
 * snapshots apart.
 */
function resolveSnapshot(ref: string): ResolvedRef | undefined {
	const uri = parseSnapshotUri(ref);
	if (uri === undefined) return undefined;
	const label = `${uri.path} @${uri.digest.slice(0, 8)}`;
	if (uri.workspace !== WORKSPACE)
		return { ...unresolved(ref, 'snapshot', `in workspace ${uri.workspace}`), label };
	return { ref, kind: 'snapshot', label, target: { kind: 'snapshot', ref, label } };
}

/** A commit of this workspace opens in the panel. The label names the repository, the branch or the tag, and the short hash. */
function resolveCommit(ref: string): ResolvedRef | undefined {
	const uri = parseCommitUri(ref);
	if (uri === undefined) return undefined;
	const label = [uri.repository, uri.branch ?? uri.tag, uri.commit.slice(0, 7)]
		.filter(Boolean)
		.join(' ');
	if (uri.workspace !== WORKSPACE)
		return { ...unresolved(ref, 'commit', `in workspace ${uri.workspace}`), label };
	return { ref, kind: 'commit', label, target: { kind: 'commit', ref, label } };
}

function resolveMessage(ref: string, known: Known): ResolvedRef {
	const uri = parseRoomUri(ref);
	if (uri?.message === undefined) return unresolved(ref, 'unknown', 'names a room, not a message');
	if (uri.room !== known.room) return unresolved(ref, 'message', `in room ${uri.room}`);
	if (!known.seqs.has(uri.message))
		return unresolved(ref, 'message', `message ${uri.message} is not read yet`);
	return {
		ref,
		kind: 'message',
		label: `${uri.message}`,
		target: { kind: 'message', seq: uri.message },
	};
}

/** Resolve one ref. A ref of another scheme is `unknown` and opens nothing. */
export function resolveRef(ref: string, known: Known): ResolvedRef {
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(ref)?.[1]?.toLowerCase();
	if (scheme === 'file') return resolveFile(ref, known);
	if (scheme === 'ambion')
		return resolveSnapshot(ref) ?? resolveCommit(ref) ?? resolveMessage(ref, known);
	return unresolved(ref, 'unknown', 'this scheme opens nothing');
}

/**
 * One line for one ref, fitted to `width` cells. The marker and the kind stay
 * whole, and the ref text takes the ellipsis. A ref that does not resolve
 * ends with the reason.
 */
export function chipLine(item: ResolvedRef, width: number): string {
	const kind = item.kind === 'unknown' ? 'ref' : item.kind;
	const head = `${item.target ? '↗' : '✗'} ${kind}  `;
	const tail = item.problem ? `  (${item.problem})` : '';
	const room = Math.max(4, width - head.length - tail.length);
	return `${head}${ellipsize(item.label, room)}${tail}`;
}

/** The messages that the blocks show. */
function shownMessages(blocks: readonly Block[]): Message[] {
	return blocks.flatMap((block) => (block.type === 'message' ? [block.message] : []));
}

/** The refs of the shown messages, top to bottom and in the order each message lists them. */
export function refItems(blocks: readonly Block[], known: Known): RefItem[] {
	return shownMessages(blocks).flatMap((message) =>
		(message.kind === 'said' ? (message.refs ?? []) : []).map((ref, index) => ({
			id: `${message.seq}#${index}`,
			seq: message.seq,
			resolved: resolveRef(ref, known),
		})),
	);
}

/**
 * One file, snapshot path, or repository that the messages cite. The row keeps
 * the newest citation: who cited it, when, and in which message.
 */
export interface CitedFile {
	/** Names the thing across its versions: a workspace path, or `commit:<repository>`. */
	key: string;
	/** What the files layer opens for the newest citation: a workspace path, a snapshot ref, or a commit ref. */
	open: string;
	/** The text that names the row: a path, or a repository with its branch and hash. */
	label: string;
	/** Every ref the messages cite under the key, one for each version: the file, each snapshot, each commit. */
	opens: readonly string[];
	/** The name of the author of the newest citing message, as the message gives it. */
	author: string;
	/** When that message landed. */
	at: string;
	/** The seq of that message. */
	seq: number;
}

/** What one resolved ref cites, before the messages are counted. */
type Citation = Pick<CitedFile, 'key' | 'open' | 'label'>;

/** The thing a ref cites in the files layer, or undefined when the ref opens no file. */
function citation(target: RefTarget | undefined): Citation | undefined {
	if (target?.kind === 'file') return { key: target.path, open: target.path, label: target.path };
	if (target?.kind === 'snapshot') {
		const path = parseSnapshotUri(target.ref)?.path ?? target.label;
		return { key: path, open: target.ref, label: path };
	}
	if (target?.kind === 'commit') {
		const repository = parseCommitUri(target.ref)?.repository ?? target.label;
		return { key: `commit:${repository}`, open: target.ref, label: target.label };
	}
	return undefined;
}

/** What `citedFiles` gathers: the newest citation of each key, and the things cited under it. */
interface Gathered {
	rows: Map<string, CitedFile>;
	opens: Map<string, Set<string>>;
}

/** Add one citation by the message at hand. The newest message keeps the row. */
function gather(gathered: Gathered, message: SaidMessage, cited: Citation): void {
	const { rows, opens } = gathered;
	opens.set(cited.key, (opens.get(cited.key) ?? new Set<string>()).add(cited.open));
	const before = rows.get(cited.key);
	if (before && message.seq < before.seq) return;
	rows.set(cited.key, {
		...cited,
		opens: [],
		author: message.from,
		at: message.at,
		seq: message.seq,
	});
}

/**
 * The files that the messages cite, newest citation first. A ref to a file or to
 * a snapshot of it joins one row for its path, and a ref to a commit joins one
 * row for its repository. A ref that does not resolve, and a ref to a message,
 * cite no file. The row names the author of the newest message that cites the
 * thing, as that message gives the name.
 */
export function citedFiles(messages: readonly Message[], known: Known): CitedFile[] {
	const gathered: Gathered = { rows: new Map(), opens: new Map() };
	for (const message of messages) {
		if (message.kind !== 'said') continue;
		for (const ref of message.refs ?? []) {
			const cited = citation(resolveRef(ref, known).target);
			if (cited) gather(gathered, message, cited);
		}
	}
	return [...gathered.rows.values()]
		.map((row) => ({ ...row, opens: [...(gathered.opens.get(row.key) ?? [])] }))
		.sort((a, b) => b.seq - a.seq);
}

/** True when the blocks show the message at `seq`. */
export function shows(blocks: readonly Block[], seq: number): boolean {
	return shownMessages(blocks).some((message) => message.seq === seq);
}

const STAY_PICK = 'stay:';

/** The id that the pick key gives to the folded line of an activation. */
export const stayPick = (activation: string): string => `${STAY_PICK}${activation}`;

/** The activation of a folded line that a pick names, or undefined when the pick names a ref. */
export const stayOfPick = (pick: string): string | undefined =>
	pick.startsWith(STAY_PICK) ? pick.slice(STAY_PICK.length) : undefined;

/**
 * What the pick key can choose, top to bottom: each ref of a shown message, and
 * each folded activation line. A ref has the id of its `RefItem`.
 */
export function pickIds(blocks: readonly Block[], known: Known): string[] {
	return blocks.flatMap((block) => {
		if (block.type === 'message') return refItems([block], known).map((item) => item.id);
		return block.type === 'stays' ? block.items.map((item) => stayPick(item.id)) : [];
	});
}
