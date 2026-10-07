import type { Message, SystemMessage } from '@ambionframework/ambion';
import {
	BoxRenderable,
	bg,
	bold,
	type CliRenderer,
	fg,
	ImageRenderable,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import type { LiveActivation, LiveCall, LiveProcess } from '../../view/live.ts';
import { chipLine, type RefItem, stayPick, systemPick } from '../../view/refs.ts';
import { failedKind, NO_STEPS, type PassView } from '../../view/steps.ts';
import { systemRow } from '../../view/system.ts';
import { ellipsize } from '../../view/text.ts';
import type {
	Block,
	LiveBlock,
	MessageBlock,
	Role,
	StayItem,
	StaysBlock,
	StepsBlock,
} from '../../view/timeline.ts';
import { type Strip, stripKey } from '../state/pictures.ts';
import { tui as palette } from './brand.ts';
import { markdownBody } from './markdown-style.ts';
import { planRows } from './row-diff.ts';
import { APART, GAP, GUTTER, INSET, SCROLLBAR, TRACK } from './space.ts';

/** The cells a chip loses to the rail and its gutter, the padding, and the scrollbar track. */
const CHIP_MARGIN = INSET + SCROLLBAR + TRACK;
const CHIP_MIN = 20;

/** The cells that a call line starts with: the indent, the mark, and one space. */
const CALL_PREFIX = 6;

/** The cells that a live call line loses to the inset, the prefix, the padding, and the scrollbar track. */
const CALL_MARGIN = INSET + CALL_PREFIX + SCROLLBAR + TRACK;
const CALL_MIN = 20;

/** The cells that a folded system row loses to the inset, the scrollbar, and its track. */
const ROW_MARGIN = INSET + SCROLLBAR + TRACK;
const ROW_MIN = 20;

/** The most cells that the source of a folded system row takes. */
const SOURCE_MAX = 20;

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
	if (message.kind === 'said' || message.kind === 'system') return message.text ?? '';
	return '';
}

/** When a say to oneself returns, as a clock time after its header, or `dismissed` when a dismissal names it. */
function returnsAt({ message, dismissed }: MessageBlock): string {
	if (message.kind !== 'said' || message.delaySeconds === undefined) return '';
	if (dismissed) return '  dismissed';
	return `  returns ${clock(new Date(Date.parse(message.at) + message.delaySeconds * 1000).toISOString())}`;
}

/** A post of the host reads `system`, and a say that the room returned reads `returned`. */
function systemHeader(message: SystemMessage, at: Chunk, fill?: string): Chunk[] {
	const label = message.returns === undefined ? 'system' : 'returned';
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
	if (message.kind === 'system') return systemHeader(message, at, fill);
	const arrow = to ? paint(` → ${to}`, { color: palette.muted, fill }) : paint('', { fill });
	const returns = paint(returnsAt(block), { color: palette.accent, fill });
	return [paint(from, { color: palette.accent, fill }), arrow, returns, at];
}

/** The mark of an activation in the live block, by state. */
const ACTIVATION_MARK = {
	running: { text: '●', color: palette.coral },
	done: { text: '✓', color: palette.green },
	failed: { text: '✗', color: palette.red },
} as const;

/** The mark of a call in the live block, by state. */
const CALL_MARK = {
	running: { text: '…', color: palette.dim },
	done: { text: '✓', color: palette.green },
	failed: { text: '✗', color: palette.red },
} as const;

const railOf: Record<Role, string> = {
	question: palette.text,
	said: palette.line,
	system: palette.green,
};

/** One row of the conversation: its node, and the signature of everything the node was built from. */
interface Entry {
	signature: string;
	node: BoxRenderable | TextRenderable;
}

/** The pick ids of the rows that a block draws: the folded activation lines, or the row of a system message. */
function rowPicksOf(block: Block): string[] {
	if (block.type === 'stays') return block.items.map((item) => stayPick(item.id));
	return block.type === 'message' && block.role === 'system' ? [systemPick(block.message.seq)] : [];
}

/** True when the block draws a row that fits its text to the width. */
const fitsRow = (block: Block): boolean =>
	block.type === 'stays' || (block.type === 'message' && block.role === 'system' && !block.open);

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
	// A row that the person chose changes its block, and a width change refits its text.
	const chosen = rowPicksOf(block).find((id) => id === marks.picked) ?? null;
	const fit = refs.length > 0 || fitsRow(block) ? width : 0;
	return JSON.stringify([block, refs, picked, focus, fit, strips, shape, chosen]);
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
			paddingRight: SCROLLBAR,
			gap: GAP,
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
		if (block.type === 'message') return this.messageOrRow(block, marks);
		if (block.type === 'live') return this.liveNode(block);
		if (block.type === 'steps') return this.stepsNode(block);
		if (block.type === 'stays') return this.staysNode(block, marks);
		return this.plain([paint(block.text, { color: palette.dim })]);
	}

	private text(chunks: Chunk[]): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText(chunks),
			wrapMode: 'word',
			width: '100%',
		});
	}

	/** A message in full, or a folded system message as one row. */
	private messageOrRow(block: MessageBlock, marks: Marks): BoxRenderable {
		const { message } = block;
		return message.kind === 'system' && !block.open
			? this.systemRowNode(message, marks)
			: this.messageNode(block, marks);
	}

	private messageNode(block: MessageBlock, marks: Marks): BoxRenderable {
		const focused = marks.focus === block.message.seq;
		const fill = focused ? palette.selected : undefined;
		const box = new BoxRenderable(this.renderer, {
			id: `message-${block.message.seq}`,
			flexDirection: 'column',
			border: ['left'],
			borderColor: railOf[block.role],
			paddingLeft: GUTTER,
			backgroundColor: fill ?? palette.bg,
		});
		const chosen = marks.picked === systemPick(block.message.seq);
		box.add(this.text(headerOf(block, chosen ? palette.selected : fill)));
		const body = bodyOf(block.message);
		if (body) box.add(markdownBody(this.renderer, body, fill));
		const width = Math.max(CHIP_MIN, this.root.width - CHIP_MARGIN);
		for (const item of marks.refs.get(block.message.seq) ?? [])
			box.add(this.chip(item, item.id === marks.picked, width, fill));
		for (const strip of marks.pictures?.get(block.message.seq) ?? [])
			this.addStrip(box, strip, width, marks.cellAspect ?? CELL_ASPECT);
		return box;
	}

	/** A system message folded to one dim row. A chosen row or a focused message shows a highlight. */
	private systemRowNode(message: SystemMessage, marks: Marks): BoxRenderable {
		const chosen = marks.picked === systemPick(message.seq);
		const fill = chosen || marks.focus === message.seq ? palette.selected : undefined;
		const box = new BoxRenderable(this.renderer, {
			id: `message-${message.seq}`,
			flexDirection: 'column',
			width: '100%',
			paddingLeft: INSET,
		});
		box.add(this.line(this.systemChunks(message, fill)));
		return box;
	}

	/**
	 * The chunks of a folded system row: the mark, the source, the first line of the
	 * text, and the clock time. The text takes the ellipsis, so the row fits one line.
	 */
	private systemChunks(message: SystemMessage, fill: string | undefined): Chunk[] {
		const row = systemRow(message);
		const source = ellipsize(row.source, SOURCE_MAX);
		const at = clock(message.at);
		const fixed = row.mark.length + 1 + source.length + (at ? APART + at.length : 0) + APART;
		const text = ellipsize(row.text, Math.max(ROW_MIN, this.root.width - ROW_MARGIN) - fixed);
		return [
			paint(`${row.mark} `, { color: palette.dim, fill }),
			paint(source, { color: palette.muted, fill }),
			...(text ? [paint(`${' '.repeat(APART)}${text}`, { color: palette.dim, fill })] : []),
			...(at ? [paint(`${' '.repeat(APART)}${at}`, { color: palette.dim, fill })] : []),
		];
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
			paddingLeft: GUTTER,
		});
		const state = block.running ? '  running, no end step yet' : '';
		box.add(
			this.text([
				paint('Steps ', { color: palette.accent, strong: true }),
				paint(block.title, { color: palette.muted }),
				paint(state, { color: palette.coral }),
			]),
		);
		this.addPasses(box, block.passes);
		return box;
	}

	/** The passes of an activation, each with its step lines, as `/steps` and an expanded line draw them. */
	private addPasses(box: BoxRenderable, passes: readonly PassView[]): void {
		for (const pass of passes) {
			box.add(
				this.text([
					paint(`Pass ${pass.pass}`, { strong: true }),
					paint(`  reads ${pass.input} to ${pass.through}`, { color: palette.dim }),
				]),
			);
			for (const line of pass.lines) {
				const color = failedKind(line.kind) ? palette.red : palette.muted;
				box.add(
					this.text([
						paint(`  ${line.kind.padEnd(9)}`, { color: palette.dim }),
						paint(line.text, { color }),
					]),
				);
			}
		}
	}

	/** The folded activation lines that lead to a message. Each is one row, and an expanded one adds its steps. */
	private staysNode(block: StaysBlock, marks: Marks): BoxRenderable {
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			width: '100%',
			paddingLeft: INSET,
		});
		for (const item of block.items) box.add(this.stayRow(item, stayPick(item.id) === marks.picked));
		return box;
	}

	private stayRow(item: StayItem, picked: boolean): BoxRenderable {
		const fill = picked ? palette.selected : undefined;
		const row = new BoxRenderable(this.renderer, {
			id: `stay-${item.id}`,
			flexDirection: 'column',
			width: '100%',
		});
		row.add(this.line(this.stayChunks(item, fill)));
		if (!item.open) return row;
		if (item.open.passes.length === 0)
			row.add(this.text([paint(`  ${NO_STEPS}`, { color: palette.dim })]));
		this.addPasses(row, item.open.passes);
		return row;
	}

	/**
	 * The chunks of a folded activation: the mark, the title in the dim colour, and
	 * the reason of a failure in red. The line fits one row.
	 */
	private stayChunks(item: StayItem, fill: string | undefined): Chunk[] {
		const mark = ACTIVATION_MARK[item.state];
		const room = Math.max(CALL_MIN, this.root.width - CALL_MARGIN);
		const title = ellipsize(item.title, room);
		const left = room - title.length - 3;
		const reason = item.reason && left > 1 ? ellipsize(item.reason, left) : '';
		return [
			paint(`${mark.text} `, { color: mark.color, fill }),
			paint(title, { color: palette.dim, fill }),
			...(reason ? [paint(` · ${reason}`, { color: palette.red, fill })] : []),
		];
	}

	/** The live block: one line of state, then each activation with its latest calls. */
	private liveNode(block: LiveBlock): BoxRenderable {
		const detail = block.detail ? [paint(`   ${block.detail}`, { color: palette.dim })] : [];
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			width: '100%',
			paddingLeft: INSET,
		});
		box.add(
			this.text([
				paint('● ', { color: palette.coral }),
				paint(block.text, { color: palette.muted }),
				...detail,
				paint('   /abort cancels it', { color: palette.dim }),
			]),
		);
		for (const activation of block.activations) this.addActivation(box, activation);
		return box;
	}

	private addActivation(box: BoxRenderable, activation: LiveActivation): void {
		box.add(this.line(this.headerChunks(activation)));
		if (activation.earlier > 0)
			box.add(
				this.line([
					paint(`    +${activation.earlier} earlier call${activation.earlier === 1 ? '' : 's'}`, {
						color: palette.dim,
					}),
				]),
			);
		for (const call of activation.calls) box.add(this.line(this.callChunks(call)));
		for (const process of activation.processes ?? [])
			box.add(this.line(this.processChunks(process)));
	}

	/**
	 * The chunks of the header of an activation: the mark, the title, and the
	 * step it does now. The header fits one row, and the title keeps its room
	 * before the step.
	 */
	private headerChunks(activation: LiveActivation): Chunk[] {
		const mark = ACTIVATION_MARK[activation.state];
		const room = Math.max(CALL_MIN, this.root.width - CALL_MARGIN);
		const title = ellipsize(activation.title, room);
		const left = room - title.length - 3;
		const step = activation.step && left > 1 ? ellipsize(activation.step, left) : '';
		return [
			paint(`  ${mark.text} `, { color: mark.color }),
			paint(title, { color: palette.muted }),
			...(step ? [paint(` · ${step}`, { color: palette.dim })] : []),
		];
	}

	/**
	 * The chunks of one process line: the mark, the name and the time it runs,
	 * and the newest output line. The line fits one row.
	 */
	private processChunks(process: LiveProcess): Chunk[] {
		const room = Math.max(CALL_MIN, this.root.width - CALL_MARGIN);
		const head = ellipsize(`${process.name} · ${process.runs}`, room);
		const left = room - head.length - 3;
		const line = process.line && left > 1 ? ellipsize(process.line, left) : '';
		return [
			paint('    ▸ ', { color: palette.dim }),
			paint(head, { color: palette.dim }),
			...(line ? [paint(` · ${line}`, { color: palette.dim })] : []),
		];
	}

	/** The chunks of one call line: the mark, the call, and its result. The line fits one row. */
	private callChunks(call: LiveCall): Chunk[] {
		const mark = CALL_MARK[call.state];
		const room = Math.max(CALL_MIN, this.root.width - CALL_MARGIN);
		const text = ellipsize(call.text, room);
		const left = room - text.length - 2;
		const result = call.result && left > 1 ? ellipsize(call.result, left) : '';
		const color = call.state === 'failed' ? palette.red : palette.dim;
		return [
			paint(`    ${mark.text} `, { color: mark.color }),
			paint(text, { color: palette.text }),
			...(result ? [paint(`  ${result}`, { color })] : []),
		];
	}

	/** One row that does not wrap. */
	private line(chunks: Chunk[]): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText(chunks),
			wrapMode: 'none',
			width: '100%',
		});
	}

	private noticeNode(notice: string): TextRenderable {
		return this.plain([paint(notice, { color: palette.muted })]);
	}

	/** Text that has no rail. It starts at the same column as the text beside a rail. */
	private plain(chunks: Chunk[]): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText(chunks),
			wrapMode: 'word',
			marginLeft: INSET,
		});
	}
}
