import type { Message, PostedMessage } from '@ambionframework/ambion';
import {
	BoxRenderable,
	bg,
	bold,
	type CliRenderer,
	fg,
	ImageRenderable,
	MarkdownRenderable,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { chipLine, type RefItem } from '../../view/refs.ts';
import { ellipsize } from '../../view/text.ts';
import type { Block, LiveBlock, MessageBlock, Role, StepsBlock } from '../../view/timeline.ts';
import { type Strip, stripKey } from '../state/pictures.ts';
import { tui as palette } from './brand.ts';
import { markdownStyle } from './markdown-style.ts';
import { planRows } from './row-diff.ts';

/** The cells a chip loses to the padding, the rail, and the scrollbar. */
const CHIP_MARGIN = 8;
const CHIP_MIN = 20;

/** The rows of one thumbnail. */
const THUMB_ROWS = 8;
/** A thumbnail box has the shape of a 4:3 picture. */
const THUMB_SHAPE = 4 / 3;
/** The cell height over the cell width, when the terminal reports no pixel size. */
const CELL_ASPECT = 2;

/** What the transcript marks: refs, the chosen ref, a focused message. */
export interface Marks {
	/** The refs of the shown messages, by the seq of the message. */
	refs: ReadonlyMap<number, readonly RefItem[]>;
	/** The id of the chosen ref. */
	picked?: string;
	/** The seq of the message a ref jumped to. */
	focus?: number;
	/**
	 * The strips of thumbnails under the messages, by seq. The painter fills it
	 * only for a terminal that draws Kitty graphics. Without it, a message shows chips only.
	 */
	pictures?: ReadonlyMap<number, readonly Strip[]>;
	/** The height of a cell over its width, for the size of the thumbnails. */
	cellAspect?: number;
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

const clock = (at: string | undefined): string => {
	const date = at ? new Date(at) : undefined;
	if (!date || Number.isNaN(date.valueOf())) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function bodyOf(message: Message): string {
	if (message.kind === 'said' || message.kind === 'posted') return message.text ?? '';
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
	const from = message.kind === 'said' ? (message.from ?? '') : '';
	const to = message.kind === 'said' ? message.to : undefined;
	const at = paint(`  ${clock(message.at)}`, { color: palette.dim, fill });
	if (role === 'question') return [paint(from, { strong: true, fill }), at];
	if (message.kind === 'posted') return postedHeader(message, at, fill);
	const arrow = to ? paint(` → ${to}`, { color: palette.muted, fill }) : paint('', { fill });
	const returns = paint(returnsAt(block), { color: palette.accent, fill });
	return [paint(from, { color: palette.accent, fill }), arrow, returns, at];
}

const railOf: Record<Role, string> = {
	question: palette.text,
	said: palette.line,
	posted: palette.green,
};

/** One row of the conversation: its node, and the signature of everything the node was built from. */
interface Entry {
	signature: string;
	node: BoxRenderable | TextRenderable;
}

/** The seqs of the messages that a block draws, for the marks that fall on it. */
function seqsOf(block: Block): number[] {
	return block.type === 'message' ? [block.message.seq] : [];
}

/**
 * Everything a block's node is built from: the block, the refs that fall on its messages, which of them is chosen, which message
 * has the focus, and the width the chips were fitted to. Two equal signatures make
 * two equal nodes, so the transcript keeps the node it has.
 */
function signatureOf(block: Block, marks: Marks, width: number) {
	const seqs = seqsOf(block);
	const refs = seqs.flatMap((seq) => marks.refs.get(seq) ?? []);
	// The values, not whether they fall on the block: a mark that moves inside one block changes its nodes.
	const picked = refs.find((item) => item.id === marks.picked)?.id ?? null;
	const focus = marks.focus !== undefined && seqs.includes(marks.focus) ? marks.focus : null;
	// The key of each strip holds no bytes. A loaded picture changes the key.
	const strips = seqs.flatMap((seq) => (marks.pictures?.get(seq) ?? []).map(stripKey));
	const shape = strips.length > 0 ? [width, marks.cellAspect ?? CELL_ASPECT] : null;
	return JSON.stringify([block, refs, picked, focus, refs.length > 0 ? width : 0, strips, shape]);
}

/**
 * The conversation: the blocks of a room.
 *
 * It keeps one node for each block. A new state replaces only the rows between
 * the rows that stay the same at the top and at the bottom, so a new message,
 * or a live block that changes costs a few nodes and not the whole
 * conversation.
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
	 * Draw the blocks again. Drawing again resets the scroll position, so the transcript puts it back once
	 * the layout is known: at the bottom when it was there, at the same line when it
	 * was not, or at the node the caller asks to reveal, by its id. The caller can
	 * also ask for the bottom, as after a notice or a message that the person sent.
	 */
	render(
		blocks: readonly Block[],
		notice: string | undefined,
		reveal?: string,
		bottom = false,
		marks: Marks = { refs: new Map() },
	): void {
		const stick = this.atBottom();
		const top = this.root.scrollTop;
		const width = this.root.width;
		const wanted = blocks.map((block) => ({
			signature: signatureOf(block, marks, width),
			build: () => this.blockNode(block, marks),
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

	private blockNode(block: Block, marks: Marks): BoxRenderable | TextRenderable {
		if (block.type === 'message') return this.messageNode(block, marks);
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

	private messageNode(block: MessageBlock, marks: Marks): BoxRenderable {
		const focused = marks.focus === block.message.seq;
		const fill = focused ? palette.selected : undefined;
		const box = new BoxRenderable(this.renderer, {
			id: `message-${block.message.seq}`,
			flexDirection: 'column',
			border: ['left'],
			borderColor: railOf[block.role],
			paddingLeft: 1,
			backgroundColor: fill ?? palette.bg,
		});
		box.add(this.text(headerOf(block, fill)));
		const body = bodyOf(block.message);
		if (body) box.add(this.markdown(body, fill));
		const width = Math.max(CHIP_MIN, this.root.width - CHIP_MARGIN);
		for (const item of marks.refs.get(block.message.seq) ?? [])
			box.add(this.chip(item, item.id === marks.picked, width, fill));
		for (const strip of marks.pictures?.get(block.message.seq) ?? [])
			this.addStrip(box, strip, width, marks.cellAspect ?? CELL_ASPECT);
		return box;
	}

	/** The body of a message, as Markdown with the markers concealed. */
	private markdown(content: string, fill: string | undefined): MarkdownRenderable {
		return new MarkdownRenderable(this.renderer, {
			content,
			syntaxStyle: markdownStyle(),
			width: '100%',
			fg: palette.text,
			bg: fill,
			conceal: true,
			tableOptions: { style: 'columns', wrapMode: 'word' },
		});
	}

	/** One thumbnail, then one caption line. A thumbnail wider than the transcript shrinks to fit. */
	private addStrip(box: BoxRenderable, strip: Strip, width: number, aspect: number): void {
		const cells = Math.min(width, Math.max(1, Math.round(THUMB_ROWS * aspect * THUMB_SHAPE)));
		const row = new BoxRenderable(this.renderer, {
			flexDirection: 'row',
			height: THUMB_ROWS,
			alignItems: 'flex-end',
		});
		row.add(
			new ImageRenderable(this.renderer, {
				width: cells,
				height: THUMB_ROWS,
				fit: 'fit',
				protocol: 'kitty',
				source: strip.picture.data,
			}),
		);
		box.add(row);
		box.add(
			new TextRenderable(this.renderer, {
				content: new StyledText([paint(ellipsize(strip.caption, width), { color: palette.dim })]),
				wrapMode: 'none',
				width: '100%',
			}),
		);
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
