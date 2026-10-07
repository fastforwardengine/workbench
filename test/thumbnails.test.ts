/**
 * The thumbnails under a message. A test renderer has no Kitty graphics, so
 * the painter draws none there. The transcript draws the strips that the marks
 * hold, and these tests drive it with strips directly.
 */

import { snapshotUri } from '@ambionframework/ambion';
import { ImageRenderable, type Renderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Painter } from '../src/terminal/app/draw.ts';
import { PictureCache } from '../src/terminal/state/picture-cache.ts';
import type { Strip } from '../src/terminal/state/pictures.ts';
import { Composer } from '../src/terminal/widgets/composer.ts';
import { Header } from '../src/terminal/widgets/header.ts';
import { type Marks, Transcript } from '../src/terminal/widgets/transcript.ts';
import type { Block } from '../src/view/timeline.ts';
import { started, view } from './fake-host.ts';
import { PNG } from './png.ts';
import { quietVoice } from './voice-fakes.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const AT = '2026-10-03T10:00:00Z';
const said = (seq: number, from: string, text: string): Block =>
	({ type: 'message', role: 'said', message: { seq, kind: 'said', from, text, at: AT } }) as never;
const blocks = (): Block[] => [said(1, 'priya', 'Look'), said(2, 'engineer', 'The photo')];

const strip = (): Strip => ({
	ref: 'ambion://workspace/workbench/snapshot/x/camera.png',
	picture: { data: new Uint8Array(PNG), mimeType: 'image/png' },
	caption: 'camera.png',
});

async function mount() {
	const setup = await createTestRenderer({ width: 100, height: 40 });
	cleanups.push(() => setup.renderer.destroy());
	const transcript = new Transcript(setup.renderer);
	setup.renderer.root.add(transcript.root);
	await setup.renderOnce();
	return { setup, transcript };
}

const images = (node: Renderable): ImageRenderable[] => [
	...(node instanceof ImageRenderable ? [node] : []),
	...node.getChildren().flatMap((child) => images(child)),
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function draw(view: Awaited<ReturnType<typeof mount>>, marks: Marks): Promise<string> {
	view.transcript.render(blocks(), undefined, undefined, true, marks);
	await settle();
	await view.setup.renderOnce();
	return view.setup.captureCharFrame();
}

describe('the thumbnails under a message', () => {
	it('draws none when the marks hold no strips', async () => {
		const view = await mount();
		const frame = await draw(view, { refs: new Map() });
		expect(images(view.transcript.root)).toHaveLength(0);
		expect(frame).not.toContain('camera.png');
	});

	it('draws one thumbnail and one caption under the message', async () => {
		const view = await mount();
		const frame = await draw(view, {
			refs: new Map(),
			pictures: new Map([[2, [strip()]]]),
			cellAspect: 2,
		});
		expect(images(view.transcript.root)).toHaveLength(1);
		expect(images(view.transcript.root).every((image) => image.protocol === 'kitty')).toBe(true);
		expect(frame.split('camera.png')).toHaveLength(2);
	});

	it('shrinks the thumbnail on a narrow transcript', async () => {
		const view = await mount();
		view.setup.resize(24, 40);
		await view.setup.renderOnce();
		await draw(view, { refs: new Map(), pictures: new Map([[2, [strip()]]]), cellAspect: 2 });
		const [image] = images(view.transcript.root);
		expect(image).toBeDefined();
		expect(image?.width).toBeLessThan(21);
	});

	it('draws a picture when it loads, and keeps its node while the marks stay the same', async () => {
		const view = await mount();
		await draw(view, { refs: new Map() });
		await draw(view, { refs: new Map(), pictures: new Map([[2, [strip()]]]), cellAspect: 2 });
		const first = images(view.transcript.root);
		expect(first).toHaveLength(1);
		// The same marks again keep the node, so the image does not load again.
		await draw(view, { refs: new Map(), pictures: new Map([[2, [strip()]]]), cellAspect: 2 });
		expect(images(view.transcript.root)[0]).toBe(first[0]);
	});
});

describe('the painter and the thumbnails', () => {
	const PHOTO = snapshotUri('workbench', 'ab'.repeat(32), '/attachments/bench.png');

	async function paint(graphics: boolean) {
		const view2 = await mount();
		const { host, session } = await started();
		host.table.set(
			'characterization',
			view('characterization', {
				participants: [{ name: 'priya', kind: 'person' }],
				messages: [{ seq: 1, kind: 'said', from: 'priya', text: 'Look', at: AT, refs: [PHOTO] }],
			}),
		);
		await session.refreshRooms();
		await session.refresh();
		host.snapshot = async (ref) => {
			host.reads.push(ref);
			return {
				path: ref,
				text: '',
				truncated: false,
				image: { data: new Uint8Array(PNG), mimeType: 'image/png' },
			};
		};
		const { renderer } = view2.setup;
		const composer = new Composer(renderer, { submit: () => {}, change: () => {} });
		const redraw = vi.fn(() => painter.render('compose', undefined));
		const painter: Painter = new Painter({
			session,
			transcript: view2.transcript,
			composer,
			dock: { draw: () => {} } as never,
			header: new Header(renderer),
			voice: quietVoice(),
			pictures: new PictureCache((ref) => host.snapshot(ref), redraw),
			graphics: () => graphics,
			cellAspect: () => 2,
			width: () => 100,
		});
		painter.render('compose', undefined);
		await settle();
		await view2.setup.renderOnce();
		return { host, view: view2, painter };
	}

	it('loads nothing and draws nothing without Kitty graphics', async () => {
		const { host, view: shown } = await paint(false);
		expect(host.reads).toEqual([]);
		expect(images(shown.transcript.root)).toHaveLength(0);
	});

	it('loads the cited image and redraws with a thumbnail when Kitty graphics are on', async () => {
		const { host, view: shown } = await paint(true);
		expect(host.reads).toEqual([PHOTO]);
		expect(images(shown.transcript.root)).toHaveLength(1);
		expect(shown.setup.captureCharFrame()).toContain('bench.png');
	});
});
