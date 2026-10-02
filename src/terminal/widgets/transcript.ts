import type { Message, PostedMessage } from '@ambionframework/ambion';
import {
	BoxRenderable,
	bg,
	bold,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { chipLine, type RefItem } from '../../view/refs.ts';
import type {
	Block,
	DiscussionBlock,
	LiveBlock,
	MessageBlock,
	Role,
	StepsBlock,
} from '../../view/timeline.ts';
import { tui as palette } from './brand.ts';
import { planRows } from './row-diff.ts';

/** The cells a chip loses to the padding, the rail, and the scrollbar. */
const CHIP_MARGIN = 8;
const CHIP_MIN = 20;

/** What the transcript marks besides the selected discussion: refs, the chosen ref, a focused message. */
export interface Marks {
	/** The refs of the shown messages, by the seq of the message. */
	refs: ReadonlyMap<number, readonly RefItem[]>;
	/** The id of the chosen ref. */
	picked?: string;
	/** The seq of the message a ref jumped to. */
	focus?: number;
}

/** Wait one layout pass, so a scroll position can use the new heights. */
const SETTLE_MS = 40;

type Chunk = ReturnType<typeof fg> extends (input: never) => infer Out ? Out : never;

interface Paint {
	color?: string;
	fill?: string;
	strong?: boolean;
}

/** One styled run of text. */
function paint(text: string, { color = palette.text, fill, strong }: Paint = {}): Chunk {
	let chunk = fg(color)(text);
	if (fill) chunk = bg(fill)(chunk);
	return strong ? bold(chunk) : chunk;
}

/** A label after the row title, or an empty run when the label is empty. */
const tag = (text: string, color: string, fill: string): Chunk =>
	paint(text ? `  ${text}` : '', { color, fill });

const clock = (at: string | undefined): string => {
	const date = at ? new Date(at) : undefined;
	if (!date || Number.isNaN(date.valueOf())) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function bodyOf(message: Message): string {
	if (message.kind === 'said' || message.kind === 'summary' || message.kind === 'posted')
		return message.text ?? '';
	return '';
}

/** When a say to oneself returns, as a clock time after its header, or `dismissed` when a dismissal names it. */
function returnsAt({ message, dismissed }: MessageBlock): string {
	if (message.kind !== 'said' || message.delaySeconds === undefined) return '';
	if (dismissed) return '  dismissed';
	return `  returns ${clock(new Date(Date.parse(message.at) + message.delaySeconds * 1000).toISOString())}`;
}

/** A post of the host reads `posted`, and a say that the room returned reads `returned`. */
function postedHeader(message: PostedMessage, at: Chunk, fill?: string): Chunk[] {
	const label = message.returns === undefined ? 'posted' : 'returned';
	return [
		paint(label, { color: palette.green, strong: true, fill }),
		paint(` → ${message.to ?? 'the room'}`, { color: palette.muted, fill }),
		at,
	];
}

function headerOf(block: MessageBlock, fill?: string): Chunk[] {
	const { message, role } = block;
	const from = message.kind === 'said' || message.kind === 'summary' ? (message.from ?? '') : '';
	const to = message.kind === 'said' || message.kind === 'summary' ? message.to : undefined;
	const at = paint(`  ${clock(message.at)}`, { color: palette.dim, fill });
	if (role === 'question') return [paint(from, { strong: true, fill }), at];
	if (message.kind === 'posted') return postedHeader(message, at, fill);
	const arrow = to ? paint(` → ${to}`, { color: palette.muted, fill }) : paint('', { fill });
	if (role === 'summary')
		return [
			paint('summary', { color: palette.summary, strong: true, fill }),
			paint(` ${from}`, { color: palette.muted, fill }),
			arrow,
			at,
		];
	if (role === 'steer')
		return [
			paint('steer', { color: palette.accent, strong: true, fill }),
			paint(` ${from}`, { fill }),
			arrow,
			at,
		];
	const returns = paint(returnsAt(block), { color: palette.accent, fill });
	return [paint(from, { color: palette.accent, fill }), arrow, returns, at];
}

const railOf: Record<Role, string> = {
	question: palette.text,
	said: palette.line,
	summary: palette.summary,
	steer: palette.accent,
	posted: palette.green,
};

/** One row of the conversation: its node, and the signature of everything the node was built from. */
interface Entry {
	signature: string;
	node: BoxRenderable | TextRenderable;
}

/** The seqs of the messages that a block draws, for the marks that fall on it. */
function seqsOf(block: Block): number[] {
	if (block.type === 'message') return [block.message.seq];
	if (block.type === 'discussion' && block.expanded)
		return block.items.map((item) => item.message.seq);
	return [];
}

/**
 * Everything a block's node is built from: the block, whether it is selected,
 * the refs that fall on its messages, which of them is chosen, which message
 * has the focus, and the width the chips were fitted to. Two equal signatures make
 * two equal nodes, so the transcript keeps the node it has.
 */
function signatureOf(block: Block, selected: string | undefined, marks: Marks, width: number) {
	const seqs = seqsOf(block);
	const refs = seqs.flatMap((seq) => marks.refs.get(seq) ?? []);
	// The values, not whether they fall on the block: a mark that moves inside one block changes its nodes.
	const picked = refs.find((item) => item.id === marks.picked)?.id ?? null;
	const focus = marks.focus !== undefined && seqs.includes(marks.focus) ? marks.focus : null;
	const chosen = block.type === 'discussion' && block.key === selected;
	return JSON.stringify([block, chosen, refs, picked, focus, refs.length > 0 ? width : 0]);
}

/**
 * The conversation: the blocks of a room, with each discussion open or closed.
 *
 * It keeps one node for each block. A new state replaces only the rows between
 * the rows that stay the same at the top and at the bottom, so a new message,
 * a live block that changes, or a discussion that opens costs a few nodes and
 * not the whole conversation.
 */
export class Transcript {
	readonly root: ScrollBoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly list: BoxRenderable;
	private entries: Entry[] = [];

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			stickyScroll: true,
			stickyStart: 'bottom',
			scrollY: true,
			backgroundColor: palette.bg,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.panel, foregroundColor: palette.line },
			},
		});
		this.list = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			paddingRight: 2,
			gap: 1,
			backgroundColor: palette.bg,
		});
		this.root.add(this.list);
	}

	/**
	 * Draw the blocks again. The selected discussion, if any, shows a highlight.
	 * Drawing again resets the scroll position, so the transcript puts it back once
	 * the layout is known: at the bottom when it was there, at the same line when it
	 * was not, or at the node the caller asks to reveal, by its id. The caller can
	 * also ask for the bottom, as after a notice or a message that the person sent.
	 */
	render(
		blocks: readonly Block[],
		selected: string | undefined,
		notice: string | undefined,
		reveal?: string,
		bottom = false,
		marks: Marks = { refs: new Map() },
	): void {
		const stick = this.atBottom();
		const top = this.root.scrollTop;
		const width = this.root.width;
		const wanted = blocks.map((block) => ({
			signature: signatureOf(block, selected, marks, width),
			build: () => this.blockNode(block, selected, marks),
		}));
		if (notice)
			wanted.push({
				signature: JSON.stringify(['notice', notice]),
				build: () => this.noticeNode(notice),
			});
		this.replace(wanted);
		setTimeout(() => this.settle(stick || bottom, top, reveal), SETTLE_MS);
	}

	/**
	 * Make the rows match `wanted`. `planRows` decides which old rows stay: the
	 * rows that are the same at the top and at the bottom, and the rows between
	 * that have an old row of the same signature, in order. Every other old row
	 * is destroyed and every other wanted row is built.
	 */
	private replace(wanted: readonly { signature: string; build: () => Entry['node'] }[]): void {
		const old = this.entries;
		const plan = planRows(
			old.map((entry) => entry.signature),
			wanted.map((row) => row.signature),
		);
		const staying = new Set(plan.kept.values());
		for (let at = plan.start; at < plan.oldEnd; at += 1) {
			const entry = old[at];
			if (!entry || staying.has(at)) continue;
			this.list.remove(entry.node);
			entry.node.destroyRecursively();
		}
		// Go from the bottom, so each new node has the node below it to go before.
		const middle: Entry[] = [];
		let below = old[plan.oldEnd]?.node;
		for (let at = plan.newEnd - 1; at >= plan.start; at -= 1) {
			const entry = this.rowAt(old, plan.kept.get(at), wanted[at], below);
			if (!entry) continue;
			middle.unshift(entry);
			below = entry.node;
		}
		this.entries = [...old.slice(0, plan.start), ...middle, ...old.slice(plan.oldEnd)];
	}

	/** The kept row, or a new row built and placed before `below`. */
	private rowAt(
		old: readonly Entry[],
		keptAt: number | undefined,
		row: { signature: string; build: () => Entry['node'] } | undefined,
		below: Entry['node'] | undefined,
	): Entry | undefined {
		const kept = keptAt === undefined ? undefined : old[keptAt];
		if (kept || !row) return kept;
		const entry = { signature: row.signature, node: row.build() };
		if (below) this.list.insertBefore(entry.node, below);
		else this.list.add(entry.node);
		return entry;
	}

	scrollBy(lines: number): void {
		this.root.scrollBy(lines);
	}

	private atBottom(): boolean {
		return this.root.scrollTop + this.root.height >= this.root.scrollHeight - 1;
	}

	private settle(stick: boolean, top: number, reveal: string | undefined): void {
		if (reveal) this.root.scrollChildIntoView(reveal);
		else if (stick) this.root.scrollTop = this.root.scrollHeight;
		else this.root.scrollTop = top;
	}

	private blockNode(
		block: Block,
		selected: string | undefined,
		marks: Marks,
	): BoxRenderable | TextRenderable {
		if (block.type === 'message') return this.messageNode(block, marks, 0);
		if (block.type === 'discussion')
			return this.discussionNode(block, block.key === selected, marks);
		if (block.type === 'live') return this.liveNode(block);
		if (block.type === 'steps') return this.stepsNode(block);
		return this.text([paint(block.text, { color: palette.dim })]);
	}

	private text(chunks: Chunk[]): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText(chunks),
			wrapMode: 'word',
			width: '100%',
		});
	}

	private messageNode(block: MessageBlock, marks: Marks, indent: number): BoxRenderable {
		const focused = marks.focus === block.message.seq;
		const fill = focused ? palette.selected : block.role === 'steer' ? palette.steer : undefined;
		const box = new BoxRenderable(this.renderer, {
			id: `message-${block.message.seq}`,
			flexDirection: 'column',
			border: ['left'],
			borderColor: railOf[block.role],
			paddingLeft: 1,
			backgroundColor: fill ?? palette.bg,
		});
		const body = [paint(`\n${bodyOf(block.message)}`, { fill })];
		box.add(this.text([...headerOf(block, fill), ...body]));
		const width = Math.max(CHIP_MIN, this.root.width - CHIP_MARGIN - indent);
		for (const item of marks.refs.get(block.message.seq) ?? [])
			box.add(this.chip(item, item.id === marks.picked, width, fill));
		return box;
	}

	/** One line for one ref. A chosen ref shows a highlight, and a ref that does not resolve shows in red. */
	private chip(
		item: RefItem,
		picked: boolean,
		width: number,
		fill: string | undefined,
	): TextRenderable {
		const shade = picked ? palette.selected : fill;
		const color = item.resolved.target ? palette.accent : palette.red;
		return new TextRenderable(this.renderer, {
			content: new StyledText([paint(chipLine(item.resolved, width), { color, fill: shade })]),
			wrapMode: 'none',
			width: '100%',
		});
	}

	private discussionNode(block: DiscussionBlock, selected: boolean, marks: Marks): BoxRenderable {
		const fill = selected ? palette.selected : palette.bg;
		const row = new BoxRenderable(this.renderer, {
			id: `discussion-${block.key}`,
			backgroundColor: fill,
			width: '100%',
		});
		const count = `${block.count} ${block.count === 1 ? 'message' : 'messages'}`;
		const flag = tag(block.flag, palette.summary, fill);
		const cost = tag(block.cost, palette.muted, fill);
		const hint = tag(
			selected ? `Enter ${block.expanded ? 'closes' : 'opens'} it, s shows the steps` : '',
			palette.muted,
			fill,
		);
		row.add(
			this.text([
				paint(block.expanded ? '▾ ' : '▸ ', { color: palette.accent, fill }),
				paint('Discussion', { strong: true, fill }),
				paint(`  ${count}`, { color: palette.muted, fill }),
				paint(`  ${block.voices.join(', ')}`, {
					color: selected ? palette.muted : palette.dim,
					fill,
				}),
				flag,
				cost,
				hint,
			]),
		);
		if (!block.expanded) return row;
		const wrapper = new BoxRenderable(this.renderer, { flexDirection: 'column', gap: 1 });
		wrapper.add(row);
		const thread = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			gap: 1,
			marginLeft: 2,
		});
		for (const item of block.items) thread.add(this.messageNode(item, marks, 2));
		wrapper.add(thread);
		return wrapper;
	}

	private stepsNode(block: StepsBlock): BoxRenderable {
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			border: ['left'],
			borderColor: palette.accent,
			paddingLeft: 1,
		});
		const state = block.running ? '  running, no end step yet' : '';
		box.add(
			this.text([
				paint('Steps ', { color: palette.accent, strong: true }),
				paint(block.title, { color: palette.muted }),
				paint(state, { color: palette.coral }),
			]),
		);
		for (const pass of block.passes) {
			box.add(
				this.text([
					paint(`Pass ${pass.pass}`, { strong: true }),
					paint(`  reads ${pass.input} to ${pass.through}`, { color: palette.dim }),
				]),
			);
			for (const line of pass.lines) {
				const color = line.kind === 'error' ? palette.red : palette.muted;
				box.add(
					this.text([
						paint(`  ${line.kind.padEnd(9)}`, { color: palette.dim }),
						paint(line.text, { color }),
					]),
				);
			}
		}
		return box;
	}

	private liveNode(block: LiveBlock): TextRenderable {
		const detail = block.detail ? [paint(`   ${block.detail}`, { color: palette.dim })] : [];
		return this.text([
			paint('● ', { color: palette.coral }),
			paint(block.text, { color: palette.muted }),
			...detail,
			paint('   /abort cancels it', { color: palette.dim }),
		]);
	}

	private noticeNode(notice: string): TextRenderable {
		return this.text([paint(notice, { color: palette.muted })]);
	}
}
