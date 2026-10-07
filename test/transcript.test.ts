/**
 * The transcript keeps a node for each block and replaces only what changed.
 * Each step of a scripted run is drawn twice, on a transcript that has seen
 * every step and on a fresh one that sees this step alone, and the two frames
 * must be equal. The counts of built nodes show that the reuse happens.
 */
import {
	CodeRenderable,
	getTreeSitterClient,
	type Renderable,
	TextRenderable,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Marks, Transcript } from '../src/terminal/widgets/transcript.ts';
import type { LiveActivation } from '../src/view/live.ts';
import type { RefItem } from '../src/view/refs.ts';
import { type Block, buildTimeline } from '../src/view/timeline.ts';

/** The private method that the tests count. */
interface Builder {
	blockNode: (...args: unknown[]) => unknown;
}

const AT = '2026-01-01T00:00:00Z';
const cleanups: (() => void)[] = [];
/** The first highlight in a process starts the worker. Start it once, before any frame is compared. */
beforeAll(async () => {
	await getTreeSitterClient().highlightOnce('# x', 'markdown');
}, 30_000);

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** `count` closed exchanges: a question and three replies each. */
function room(count: number) {
	const messages: unknown[] = [];
	const exchanges: unknown[] = [];
	let seq = 1;
	for (let at = 0; at < count; at += 1) {
		const from = seq;
		messages.push({ seq: seq++, kind: 'said', from: 'priya', text: `Question ${at}`, at: AT });
		for (const who of ['researcher', 'engineer', 'researcher'])
			messages.push({ seq: seq++, kind: 'said', from: who, text: `${who} on ${at}`, at: AT });
		const through = seq - 1;
		exchanges.push({
			from,
			through,
			status: 'closed',
			person: 'priya',
			at: AT,
			outcome: { kind: 'complete' },
			summary: { kind: 'silent' },
			activations: [],
		});
	}
	return { messages, exchanges };
}

interface State {
	exchanges: number;
	tail?: Block[];
	notice?: string;
	marks?: Marks;
}

const blocksOf = (state: State): Block[] => {
	const { messages, exchanges } = room(state.exchanges);
	return buildTimeline({
		messages,
		exchanges,
		open: undefined,
		humans: new Set(['priya']),
		tail: state.tail ?? [],
		failures: new Map(),
	} as never);
};

const ref = (seq: number, index = 0): RefItem => ({
	id: `${seq}#${index}`,
	seq,
	resolved: {
		ref: `file:///shared/file-${index}.md`,
		kind: 'file',
		label: `/shared/some/very/long/path/that/needs/to/be/cut/by/the/width/of/a/chip-${index}.md`,
		target: { kind: 'file', path: `/shared/file-${index}.md` },
	},
});

const live = (detail: string, activations: LiveActivation[] = []): Block => ({
	type: 'live',
	text: 'Working on priya’s question',
	activations,
	detail,
});
/** Two activations: one that folded and one that runs with calls. */
const activations: LiveActivation[] = [
	{ id: 'a1', state: 'done', title: 'researcher · respond · $0.0012', calls: [], earlier: 0 },
	{
		id: 'a2',
		state: 'running',
		title: 'engineer · respond',
		earlier: 2,
		calls: [
			{ state: 'done', text: 'bash psu status', result: '0.00 V 0.000 A off' },
			{ state: 'failed', text: 'bash psu set 3.3 0.05', result: 'failed: port busy' },
			{ state: 'running', text: 'camera observe bench', result: '' },
		],
	},
];
const steps = (running: boolean): Block =>
	({
		type: 'steps',
		title: 'design · respond · attempt 1',
		running,
		passes: [{ pass: 1, input: 1, through: 4, lines: [{ kind: 'text', text: 'thinking' }] }],
	}) as never;

/** The states of one run: growth, marks, a live block, a notice, and shrinking. */
const RUN: [string, State][] = [
	['three exchanges', { exchanges: 3 }],
	['a fourth exchange', { exchanges: 4 }],
	['a live block', { exchanges: 4, tail: [live('engineer: reading')] }],
	['activations join the live block', { exchanges: 4, tail: [live('x', activations)] }],
	['the live block changes', { exchanges: 4, tail: [live('engineer: using bash')] }],
	['a steps block joins it', { exchanges: 4, tail: [live('x'), steps(true)] }],
	['the steps block ends', { exchanges: 4, tail: [steps(false)] }],
	['a notice', { exchanges: 4, notice: 'Created probe.' }],
	['the notice goes', { exchanges: 4 }],
	['a ref on a message', { exchanges: 4, marks: { refs: new Map([[6, [ref(6)]]]) } }],
	['the ref is chosen', { exchanges: 4, marks: { refs: new Map([[6, [ref(6)]]]), picked: '6#0' } }],
	['a message has the focus', { exchanges: 4, marks: { refs: new Map(), focus: 7 } }],
	['the room shrinks', { exchanges: 2 }],
	['the room is empty', { exchanges: 0 }],
];

async function mount() {
	const setup = await createTestRenderer({ width: 100, height: 40 });
	cleanups.push(() => setup.renderer.destroy());
	const transcript = new Transcript(setup.renderer);
	setup.renderer.root.add(transcript.root);
	// One layout pass, so the width that the chips are fitted to is known at the first draw.
	await setup.renderOnce();
	return { setup, transcript };
}

/** The first lines where two frames differ, or an empty text when they are equal. */
function difference(kept: string, fresh: string): string {
	const a = kept.split('\n');
	const b = fresh.split('\n');
	return a
		.map((line, at) =>
			line === b[at]
				? ''
				: `line ${at}:\n  kept:  ${line.trimEnd()}\n  fresh: ${(b[at] ?? '').trimEnd()}`,
		)
		.filter(Boolean)
		.slice(0, 4)
		.join('\n');
}

/** The transcript settles its scroll 40 ms after a draw. */
/**
 * Draw a state on both transcripts, one after the other, and report where the
 * frames differ. The renderers share the native layer, so they cannot draw at once.
 */
async function compare(
	kept: Awaited<ReturnType<typeof mount>>,
	fresh: Awaited<ReturnType<typeof mount>>,
	state: State,
): Promise<string> {
	const a = await draw(kept, state);
	const b = await draw(fresh, state);
	return difference(a, b);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function draw(
	view: Awaited<ReturnType<typeof mount>>,
	state: State,
	where: { bottom?: boolean; reveal?: string } = {},
): Promise<string> {
	view.transcript.render(
		blocksOf(state),
		state.notice,
		where.reveal,
		where.bottom ?? true,
		state.marks,
	);
	await settle();
	return stable(view.setup, view.transcript.root);
}

/** Whether a code block under the node still waits for the highlight worker. */
function highlighting(node: Renderable): boolean {
	if (node instanceof CodeRenderable && node.isHighlighting) return true;
	return node.getChildren().some(highlighting);
}

/** Highlighting of Markdown bodies is asynchronous: draw until no block waits and the frame holds for four passes. */
async function stable(
	setup: Awaited<ReturnType<typeof mount>>['setup'],
	root: Renderable,
): Promise<string> {
	let last = '';
	let same = 0;
	for (let pass = 0; pass < 200 && same < 4; pass += 1) {
		await setup.renderOnce();
		const frame = frameOf(setup);
		same = frame === last && !highlighting(root) ? same + 1 : 0;
		last = frame;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	return last;
}

/** The characters of the frame, then the colors of every span, so a highlight shows in the comparison. */
function frameOf(setup: Awaited<ReturnType<typeof mount>>['setup']): string {
	const spans = setup.captureSpans().lines.map((line) => JSON.stringify(line));
	return `${setup.captureCharFrame()}\n--\n${spans.join('\n')}`;
}

describe('the transcript, drawn step by step', () => {
	it('draws every step of a run exactly as a fresh transcript draws that step alone', async () => {
		const kept = await mount();
		for (const [name, state] of RUN) {
			const fresh = await mount();
			expect(await compare(kept, fresh, state), name).toBe('');
			fresh.setup.renderer.destroy();
		}
	}, 60_000);

	it('draws the same after the run goes back and forth between two states', async () => {
		const kept = await mount();
		const a: State = { exchanges: 3, tail: [live('a')] };
		const b: State = { exchanges: 5, notice: 'n' };
		for (const state of [a, b, a, b, b, a]) {
			const fresh = await mount();
			expect(await compare(kept, fresh, state)).toBe('');
			fresh.setup.renderer.destroy();
		}
	}, 60_000);
});

/** A small seeded generator, so a failing run can be run again. */
function random(seed: number) {
	let state = seed;
	return (below: number) => {
		state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
		return Math.floor((state / 4_294_967_296) * below);
	};
}

function randomState(next: (below: number) => number): State {
	const exchanges = next(7);
	const seqs = Array.from({ length: exchanges * 4 }, (_, at) => at + 1);
	// One to three refs on some messages, so the chosen ref can move inside one message.
	const refs = new Map(
		seqs
			.filter(() => next(5) === 0)
			.map(
				(seq) => [seq, Array.from({ length: 1 + next(3) }, (_, index) => ref(seq, index))] as const,
			),
	);
	const ids = [...refs.values()].flat().map((item) => item.id);
	const state: State = { exchanges, marks: { refs } };
	if (ids.length > 0 && next(2) === 0 && state.marks) state.marks.picked = ids[next(ids.length)];
	if (seqs.length > 0 && next(3) === 0 && state.marks) state.marks.focus = seqs[next(seqs.length)];
	const tails = [[], [live('a')], [live('b')], [steps(true)], [live('a'), steps(false)]];
	state.tail = tails[next(tails.length)];
	if (next(4) === 0) state.notice = `notice ${next(3)}`;
	return state;
}

describe('the transcript, drawn through random runs', () => {
	it.each([1, 2, 3])(
		'draws each step of run %i as a fresh transcript would',
		async (seed) => {
			const next = random(seed);
			const kept = await mount();
			for (let step = 0; step < 10; step += 1) {
				const state = randomState(next);
				const fresh = await mount();
				expect(await compare(kept, fresh, state), `seed ${seed}, step ${step}`).toBe('');
				fresh.setup.renderer.destroy();
			}
		},
		120_000,
	);
});

describe('the transcript after a resize', () => {
	it('fits the chips to the new width, as a fresh transcript at that width does', async () => {
		const state: State = {
			exchanges: 3,
			marks: { refs: new Map([[2, [ref(2)]]]) },
		};
		const kept = await mount();
		await draw(kept, state);
		kept.setup.resize(50, 40);
		await kept.setup.renderOnce();
		const fresh = await mount();
		fresh.setup.resize(50, 40);
		await fresh.setup.renderOnce();
		expect(await compare(kept, fresh, state)).toBe('');
	});
});

describe('the transcript when the chosen ref or the focus moves inside one block', () => {
	const refs = new Map([
		[6, [ref(6, 0), ref(6, 1)]],
		[7, [ref(7, 0)]],
	]);
	const at = (marks: Marks): State => ({ exchanges: 4, marks });

	async function moves(states: State[]) {
		const kept = await mount();
		for (const state of states) {
			const fresh = await mount();
			expect(await compare(kept, fresh, state), JSON.stringify(state.marks?.picked)).toBe('');
			fresh.setup.renderer.destroy();
		}
	}

	it('moves the chosen ref between two refs of one message', async () => {
		await moves([
			at({ refs, picked: '6#0' }),
			at({ refs, picked: '6#1' }),
			at({ refs, picked: '6#0' }),
		]);
	});

	it('moves the chosen ref between the refs of two messages', async () => {
		await moves([
			at({ refs, picked: '6#0' }),
			at({ refs, picked: '7#0' }),
			at({ refs, picked: '6#1' }),
		]);
	});

	it('moves the focus between two messages', async () => {
		await moves([at({ refs, focus: 6 }), at({ refs, focus: 7 }), at({ refs, focus: 6 })]);
	});
});

describe('the scroll position after a change', () => {
	const tall: State = { exchanges: 40 };

	it('keeps the position of a reader who scrolled up, when rows in the middle change', async () => {
		const view = await mount();
		await draw(view, tall);
		view.transcript.scrollBy(-100);
		await view.setup.renderOnce();
		const top = view.transcript.root.scrollTop;
		expect(top).toBeGreaterThan(0);
		await draw(view, { ...tall, marks: { refs: new Map([[6, [ref(6)]]]) } }, { bottom: false });
		expect(view.transcript.root.scrollTop).toBe(top);
	});

	it('follows the end of the conversation for a reader who is at the end', async () => {
		const view = await mount();
		await draw(view, tall);
		const before = view.transcript.root.scrollTop;
		await draw(view, { exchanges: 41 }, { bottom: false });
		expect(view.transcript.root.scrollTop).toBeGreaterThan(before);
	});

	it('reveals the same place as a fresh transcript does', async () => {
		const kept = await mount();
		await draw(kept, tall);
		const fresh = await mount();
		const target = { reveal: 'message-96', bottom: false };
		await draw(kept, tall, target);
		await draw(fresh, tall, target);
		expect(kept.transcript.root.scrollTop).toBe(fresh.transcript.root.scrollTop);
		expect(kept.transcript.root.scrollTop).toBeGreaterThan(0);
	});
});

describe('the nodes of rows that leave', () => {
	it('destroys each node that it removes, and only those', async () => {
		let proto: object | null = Object.getPrototypeOf(TextRenderable.prototype);
		while (proto && !Object.hasOwn(proto, 'destroyRecursively'))
			proto = Object.getPrototypeOf(proto);
		if (!proto) throw new Error('No destroyRecursively on the renderables.');
		const destroyed = vi.spyOn(proto as { destroyRecursively: () => void }, 'destroyRecursively');
		const view = await mount();
		const note = (text: string): Block => ({ type: 'note', text });
		const set = async (texts: string[]) => {
			view.transcript.render(texts.map(note), undefined, undefined, true);
			await settle();
		};
		await set(['a', 'b', 'c', 'd', 'e']);
		destroyed.mockClear();
		await set(['a', 'e']);
		expect(destroyed).toHaveBeenCalledTimes(3);
		destroyed.mockClear();
		await set(['a', 'e']);
		expect(destroyed).not.toHaveBeenCalled();
		await set(['a', 'x', 'e']);
		expect(destroyed).not.toHaveBeenCalled();
	});
});

describe('the transcript when rows change places', () => {
	const note = (text: string): Block => ({ type: 'note', text });

	it('draws a reordered, shortened, and lengthened list as a fresh transcript does', async () => {
		const lists = [
			['a', 'b', 'c', 'd'],
			['d', 'a', 'b', 'c'],
			['b', 'c', 'd', 'a'],
			['c', 'a'],
			['a', 'x', 'c', 'y', 'z'],
			['z', 'y', 'x', 'c', 'a'],
			[],
			['a'],
		];
		const kept = await mount();
		for (const list of lists) {
			const fresh = await mount();
			const draw2 = async (view: Awaited<ReturnType<typeof mount>>) => {
				view.transcript.render(list.map(note), undefined, undefined, true);
				await settle();
				await view.setup.renderOnce();
				await view.setup.renderOnce();
				return frameOf(view.setup);
			};
			const a = await draw2(kept);
			const b = await draw2(fresh);
			expect(difference(a, b), list.join()).toBe('');
			fresh.setup.renderer.destroy();
		}
	}, 60_000);
});

describe('what the transcript builds', () => {
	async function built(prepare: State) {
		const view = await mount();
		await draw(view, prepare);
		const spy = vi.spyOn(view.transcript as unknown as Builder, 'blockNode');
		return { view, spy };
	}

	it('builds every block on the first draw', async () => {
		const view = await mount();
		const spy = vi.spyOn(view.transcript as unknown as Builder, 'blockNode');
		await draw(view, { exchanges: 40 });
		expect(spy).toHaveBeenCalledTimes(blocksOf({ exchanges: 40 }).length);
	});

	it('builds nothing when the state does not change', async () => {
		const state: State = { exchanges: 40, tail: [live('a')] };
		const { view, spy } = await built(state);
		await draw(view, state);
		expect(spy).not.toHaveBeenCalled();
	});

	it('builds only the new blocks when an exchange arrives', async () => {
		const { view, spy } = await built({ exchanges: 40 });
		const before = blocksOf({ exchanges: 40 }).length;
		await draw(view, { exchanges: 41 });
		expect(spy.mock.calls.length).toBe(blocksOf({ exchanges: 41 }).length - before);
		expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
	});

	it('builds one block when the live block changes', async () => {
		const { view, spy } = await built({ exchanges: 40, tail: [live('a')] });
		await draw(view, { exchanges: 40, tail: [live('b')] });
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('builds one block when the chosen ref moves between two messages', async () => {
		const marks = (picked: string): Marks => ({
			refs: new Map([
				[6, [ref(6, 0)]],
				[7, [ref(7, 0)]],
			]),
			picked,
		});
		const { view, spy } = await built({ exchanges: 40, marks: marks('6#0') });
		await draw(view, { exchanges: 40, marks: marks('7#0') });
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe('the live block', () => {
	it('draws each activation, and the calls of a running one on one row each', async () => {
		const view = await mount();
		view.transcript.render([live('', activations)], undefined, undefined, true);
		await stable(view.setup, view.transcript.root);
		const lines = view.setup
			.captureCharFrame()
			.split('\n')
			.map((line) => line.trimEnd());
		const at = (text: string) => lines.findIndex((line) => line.includes(text));
		expect(lines[at('Working on')]).toContain('/abort cancels it');
		expect(lines[at('researcher')]).toContain('✓ researcher · respond · $0.0012');
		expect(lines[at('engineer')]).toContain('● engineer · respond');
		expect(lines[at('+2 earlier calls')]).toBe('    +2 earlier calls');
		expect(lines[at('psu status')]).toBe('    ✓ bash psu status  0.00 V 0.000 A off');
		expect(lines[at('psu set')]).toBe('    ✗ bash psu set 3.3 0.05  failed: port busy');
		expect(lines[at('camera observe')]).toBe('    … camera observe bench');
	}, 20_000);

	it('cuts a long call to one row', async () => {
		const view = await mount();
		const long = { state: 'done', text: `bash ${'x'.repeat(200)}`, result: 'ok' } as const;
		const only: LiveActivation[] = [
			{ id: 'a', state: 'running', title: 'engineer · respond', earlier: 0, calls: [long] },
		];
		view.transcript.render([live('', only)], undefined, undefined, true);
		await stable(view.setup, view.transcript.root);
		const lines = view.setup.captureCharFrame().split('\n');
		expect(lines.filter((line) => line.includes('bash xxx'))).toHaveLength(1);
		expect(lines.some((line) => line.includes('…'))).toBe(true);
	}, 20_000);
});

describe('the body of a message', () => {
	it('shows Markdown with the markers concealed, below the header', async () => {
		const view = await mount();
		const text = [
			'# Plan',
			'',
			'Use **bold** and `code` here.',
			'',
			'- one',
			'- two',
			'',
			`Long ${'word '.repeat(40)}end`,
		].join('\n');
		const message = { seq: 1, kind: 'said', from: 'engineer', text, at: AT };
		const blocks = buildTimeline({
			messages: [message],
			exchanges: [],
			open: undefined,
			humans: new Set(['priya']),
			tail: [],
			failures: new Map(),
		} as never);
		view.transcript.render(blocks, undefined, undefined, true);
		await stable(view.setup, view.transcript.root);
		const frame = view.setup.captureCharFrame();
		expect(frame).toContain('engineer');
		expect(frame).toContain('bold');
		expect(frame).not.toContain('**bold**');
		expect(frame).not.toContain('`code`');
		expect(frame).not.toContain('# Plan');
		expect(frame).toContain('Plan');
		expect(frame).toContain('- one');
		expect(frame).toContain('- two');
		const lines = frame.split('\n');
		const long = lines.filter((line) => line.includes('word'));
		expect(long.length).toBeGreaterThan(1);
		// The rail and its padding take two cells, and the scrollbar side padding takes two more.
		for (const line of long) expect(line.trimEnd().length).toBeLessThanOrEqual(100 - 4);
	}, 20_000);
});
