/** The header, drawn on OpenTUI's headless renderer: the path and the state of a breakout room. */
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

/** Draw the header at `width`, and give back the text of the rows and the color of one text. */
async function drawn(state: Partial<HeaderState>, width = 120) {
	const setup = await createTestRenderer({ width, height: 4 });
	cleanups.push(() => setup.renderer.destroy());
	const header = new Header(setup.renderer);
	setup.renderer.root.add(header.root);
	header.draw({ identity: priya, view: undefined, ...state }, width);
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

describe('the header of a breakout room', () => {
	const child = (extra: Record<string, unknown> = {}) =>
		view('build-tuners', {
			participants: [engineer],
			breakout: { parent: 'build', opener: 'engineer', state: 'running' },
			...extra,
		});

	it('shows the path, with the parent dim and the short name in the accent', async () => {
		const { frame, colorOf } = await drawn({ view: child({ goal: 'Compare tuners' }) });
		expect(frame).toContain('build › tuners');
		expect(frame).not.toContain('build-tuners');
		expect(frame).not.toContain('breakout of');
		expect(colorOf('build ›')).toBe(RGBA.fromHex(palette.dim).toString());
		expect(colorOf('tuners')).toBe(RGBA.fromHex(palette.accent).toString());
	});

	it('shows the whole name when the prefix of the parent does not match', async () => {
		const { frame } = await drawn({ view: child({ name: 'tuners' }) });
		expect(frame).toContain('build › tuners');
	});

	it('shows the state and its mark at the right edge', async () => {
		expect((await drawn({ view: child() })).frame).toContain('○ running');
		const working = child({ exchange: { id: 'x1' } });
		expect((await drawn({ view: working })).frame).toContain('● working');
		expect((await drawn({ view: child({ status: 'stopped' }) })).frame).toContain('– stopped');
		const { frame, colorOf } = await drawn({ view: child() });
		expect(frame).not.toContain('Datasheet');
		expect(colorOf('○ running')).toBe(RGBA.fromHex(palette.dim).toString());
	});

	it('shows the result of an archived room', async () => {
		const done = {
			parent: 'build',
			opener: 'engineer',
			state: 'archived',
			close: { result: 'done' },
		};
		expect((await drawn({ view: child({ breakout: done }) })).frame).toContain('✓ done');
		const failed = { ...done, close: { result: 'failed' } };
		expect((await drawn({ view: child({ breakout: failed }) })).frame).toContain('✗ failed');
		const plain = { parent: 'build', opener: 'engineer', state: 'archived' };
		expect((await drawn({ view: child({ breakout: plain }) })).frame).toContain('· archived');
	});

	it('drops the state when it does not fit beside the participants', async () => {
		const { frame } = await drawn({ view: child() }, 20);
		expect(frame).not.toContain('running');
	});

	it('shows the name and the pattern of a root room at the same edge', async () => {
		const { frame, colorOf } = await drawn({ view: room({ pattern: 'Datasheet check' }) });
		expect(frame).toContain('Datasheet check');
		expect(frame).not.toContain('›');
		expect(colorOf('build')).toBe(RGBA.fromHex(palette.accent).toString());
	});
});
