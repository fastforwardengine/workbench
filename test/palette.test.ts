/** The palette over a real composer: the row that takes the pick when the list opens. */
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { Suggestion } from '../src/terminal/state/commands.ts';
import { Composer } from '../src/terminal/widgets/composer.ts';
import { Palette } from '../src/terminal/widgets/palette.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const row = (label: string, picked = false): Suggestion => ({
	kind: 'room',
	label,
	detail: '',
	insert: `/room ${label}`,
	run: true,
	...(picked ? { picked } : {}),
});

const ROOMS = [row('build'), row('sweep'), row('bench', true), row('cycling')];

async function build() {
	const { renderer } = await createTestRenderer({ width: 80, height: 12 });
	cleanups.push(() => renderer.destroy());
	const composer = new Composer(renderer, { submit: () => {}, change: () => {} });
	renderer.root.add(composer.root);
	const palette = new Palette(composer);
	/** Refresh the palette against the rows that match the text, as `Keys` does. */
	const refresh = (rows: Suggestion[] = ROOMS) =>
		palette.refresh(true, (text) => (text.startsWith('/room') ? rows : []));
	return { composer, palette, refresh };
}

describe('Palette pick', () => {
	it('picks the flagged row when the list opens', async () => {
		const { composer, palette, refresh } = await build();
		composer.setText('/room ');
		refresh();
		expect(palette.current?.label).toBe('bench');
	});

	it('picks the first row when no row has the flag', async () => {
		const { composer, palette, refresh } = await build();
		composer.setText('/room ');
		refresh(ROOMS.map((choice) => row(choice.label)));
		expect(palette.current?.label).toBe('build');
	});

	it('keeps a pick that the person moved while the text stays', async () => {
		const { composer, palette, refresh } = await build();
		composer.setText('/room ');
		refresh();
		palette.move(1);
		refresh();
		refresh();
		expect(palette.current?.label).toBe('cycling');
	});

	it('picks the flagged row again after the palette closes and opens', async () => {
		const { composer, palette, refresh } = await build();
		composer.setText('/room ');
		refresh();
		palette.move(-2);
		expect(palette.current?.label).toBe('build');
		composer.setText('');
		refresh();
		expect(palette.open).toBe(false);
		composer.setText('/room ');
		refresh();
		expect(palette.current?.label).toBe('bench');
	});

	it('keeps the old rule when the text changes to rows without a flag', async () => {
		const { composer, palette, refresh } = await build();
		composer.setText('/room ');
		refresh();
		composer.setText('/room b');
		refresh([row('build'), row('bench')]);
		expect(palette.current?.label).toBe('bench');
		composer.setText('/room be');
		refresh([row('bench')]);
		expect(palette.current?.label).toBe('bench');
	});
});
