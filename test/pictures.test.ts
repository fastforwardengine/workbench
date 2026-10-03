import { snapshotUri } from '@ambionframework/ambion';
import { describe, expect, it, vi } from 'vitest';
import type { FileContent } from '../src/host/host.ts';
import { PictureCache } from '../src/terminal/state/picture-cache.ts';
import { pictureRefs, stripOf, stripsBySeq } from '../src/terminal/state/pictures.ts';
import { type RefItem, resolveRef } from '../src/view/refs.ts';

const known = { room: 'r', files: [], seqs: new Set<number>() };
const digest = (n: number) => n.toString(16).padStart(64, '0');
const manifest = (n: number) =>
	snapshotUri('workbench', digest(n), '/observations/bench-camera/manifest.json');
const photo = (n: number, name = 'bench.JPG') =>
	snapshotUri('workbench', digest(n), `/attachments/${name}`);
const item = (seq: number, ref: string, index = 0): RefItem => ({
	id: `${seq}#${index}`,
	seq,
	resolved: resolveRef(ref, known),
});

const picture = (size = 4) => ({ data: new Uint8Array(size), mimeType: 'image/png' });
const frames = (count: number): FileContent => ({
	path: 'm',
	text: '',
	truncated: false,
	frames: Array.from({ length: count }, (_, at) => ({
		image: picture(),
		caption: `bench-camera/camera · 2026-10-03T10:00:0${at}Z`,
	})),
});
const imageFile = (size = 4): FileContent => ({
	path: 'p',
	text: '',
	truncated: false,
	image: picture(size),
});

describe('which refs can hold pictures', () => {
	it('keeps a manifest ref and an image ref once, in order', () => {
		const refs = pictureRefs([item(1, photo(2)), item(1, manifest(1), 1), item(1, photo(2), 2)]);
		expect(refs).toEqual([photo(2), manifest(1)]);
	});

	it('skips a text snapshot, a file ref, a message ref, and a ref of another workspace', () => {
		const text = snapshotUri('workbench', digest(3), '/shared/readings.csv');
		const other = snapshotUri('lab', digest(4), '/attachments/a.png');
		const refs = pictureRefs([
			item(1, text),
			item(1, 'file:///shared/a.png', 1),
			item(1, 'ambion://room/r/message/2', 2),
			item(1, other, 3),
		]);
		expect(refs).toEqual([]);
	});
});

describe('the strip of a loaded snapshot', () => {
	it('takes four frames, counts the rest, and captions with the first frame', () => {
		const strip = stripOf(manifest(1), frames(6));
		expect(strip?.pictures).toHaveLength(4);
		expect(strip?.more).toBe(2);
		expect(strip?.caption).toBe('bench-camera/camera · 2026-10-03T10:00:00Z');
	});

	it('captions an image with its file name', () => {
		expect(stripOf(photo(2), imageFile())?.caption).toBe('bench.JPG');
	});

	it('makes no strip for a snapshot without a picture', () => {
		expect(stripOf(photo(2), { path: 'x', text: 'a', truncated: false })).toBeUndefined();
	});

	it('groups the loaded strips by message', () => {
		const items = [item(1, manifest(1)), item(2, photo(2)), item(2, manifest(3), 1)];
		const loaded = new Map([[manifest(1), stripOf(manifest(1), frames(1))]]);
		const bySeq = stripsBySeq(items, (ref) => loaded.get(ref));
		expect([...bySeq.keys()]).toEqual([1]);
	});
});

/** Wait for the loads that the cache started. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the picture cache', () => {
	it('loads a ref once, however often the screen wants it', async () => {
		const load = vi.fn(async () => imageFile());
		const changed = vi.fn();
		const cache = new PictureCache(load, changed);
		cache.want([photo(1)]);
		cache.want([photo(1)]);
		await flush();
		cache.want([photo(1)]);
		await flush();
		expect(load).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(cache.get(photo(1))?.caption).toBe('bench.JPG');
	});

	it('keeps a failed ref empty, does not retry it, and does not redraw', async () => {
		const load = vi.fn(async () => {
			throw new Error('gone');
		});
		const changed = vi.fn();
		const cache = new PictureCache(load, changed);
		cache.want([photo(1)]);
		await flush();
		cache.want([photo(1)]);
		await flush();
		expect(cache.get(photo(1))).toBeUndefined();
		expect(load).toHaveBeenCalledTimes(1);
		expect(changed).not.toHaveBeenCalled();
	});

	it('drops the oldest refs past 64, and keeps the refs that the screen shows', async () => {
		const cache = new PictureCache(async () => imageFile(), vi.fn());
		for (let at = 1; at <= 70; at += 1) {
			cache.want([photo(at)]);
			await flush();
		}
		expect(cache.size).toBe(64);
		expect(cache.get(photo(1))).toBeUndefined();
		expect(cache.get(photo(70))).toBeDefined();
		const shown = Array.from({ length: 70 }, (_, at) => photo(at + 1));
		cache.want(shown);
		await flush();
		expect(cache.size).toBe(70);
	});

	it('bounds the bytes it keeps', async () => {
		const cache = new PictureCache(async () => imageFile(40 * 1_048_576), vi.fn());
		cache.want([photo(1)]);
		await flush();
		cache.want([photo(2)]);
		await flush();
		expect(cache.get(photo(1))).toBeUndefined();
		expect(cache.get(photo(2))).toBeDefined();
	});
});
