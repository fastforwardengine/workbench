/** The header, drawn on OpenTUI's headless renderer: the background chip and the label of a breakout room. */
import { RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { Person } from '../src/host/host.ts';
import { tui as palette } from '../src/terminal/widgets/brand.ts';
import { Header, type HeaderState } from '../src/terminal/widgets/header.ts';
import { view } from './fake-host.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const priya = { name: 'priya', role: 'Hardware lead' } as unknown as Person;
const engineer = { kind: 'agent', name: 'engineer', identity: 'B', status: 'idle' };
const CHIP = '⇉ 2 in background';
const none = { running: 0, working: false };

/** Draw the header at `width`, and give back the text of the rows and the color of one text. */
async function drawn(state: Partial<HeaderState>, width = 120) {
	const setup = await createTestRenderer({ width, height: 4 });
	cleanups.push(() => setup.renderer.destroy());
	const header = new Header(setup.renderer);
	setup.renderer.root.add(header.root);
	header.draw({ identity: priya, view: undefined, background: none, ...state }, width);
	await setup.renderOnce();
	await setup.renderOnce();
	const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
	return {
		frame: setup.captureCharFrame(),
		colorOf: (text: string) => spans.find((span) => span.text.includes(text))?.fg.toString(),
	};
}

const room = (extra: Record<string, unknown> = {}) =>
	view('build', { participants: [engineer], ...extra });

describe('the background chip of the header', () => {
	it('shows beside the participants in dim while the breakout rooms wait', async () => {
		const { frame, colorOf } = await drawn({
			view: room(),
			background: { running: 2, working: false },
		});
		expect(frame).toContain(`○ engineer  ${CHIP}`);
		expect(colorOf(CHIP)).toBe(RGBA.fromHex(palette.dim).toString());
	});

	it('turns coral while a breakout room has an open exchange', async () => {
		const { colorOf } = await drawn({
			view: room(),
			background: { running: 2, working: true },
		});
		expect(colorOf(CHIP)).toBe(RGBA.fromHex(palette.coral).toString());
	});

	it('shows no chip when no breakout room runs', async () => {
		const { frame } = await drawn({ view: room() });
		expect(frame).not.toContain('in background');
	});

	it('drops before the participant names on a narrow terminal', async () => {
		// The row has 27 cells inside the padding. The participants take 10, and the chip needs 19 more.
		const { frame } = await drawn({ view: room(), background: { running: 2, working: false } }, 30);
		expect(frame).toContain('○ engineer');
		expect(frame).not.toContain('⇉');
	});
});

describe('the header of a breakout room', () => {
	const child = (extra: Record<string, unknown> = {}) =>
		view('compare-tuners', {
			participants: [engineer],
			breakout: { parent: 'build', opener: 'engineer', state: 'running' },
			...extra,
		});

	it('names the parent at the right edge', async () => {
		const { frame, colorOf } = await drawn({ view: child() });
		expect(frame).toContain('breakout of build');
		expect(frame).not.toContain('done');
		expect(colorOf('breakout of build')).toBe(RGBA.fromHex(palette.dim).toString());
	});

	it('adds the result of an archived room', async () => {
		const done = {
			parent: 'build',
			opener: 'engineer',
			state: 'archived',
			close: { result: 'done' },
		};
		expect((await drawn({ view: child({ breakout: done }) })).frame).toContain(
			'breakout of build · done',
		);
		const failed = { ...done, close: { result: 'failed' } };
		expect((await drawn({ view: child({ breakout: failed }) })).frame).toContain(
			'breakout of build · failed',
		);
	});

	it('shows the pattern of a root room at the same edge', async () => {
		const { frame } = await drawn({ view: room({ pattern: 'Datasheet check' }) });
		expect(frame).toContain('Datasheet check');
	});
});
