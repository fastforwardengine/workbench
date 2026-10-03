import { snapshotUri } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { parseManifestFrames } from '../src/view/manifest.ts';

const digest = (letter: string) => letter.repeat(64);
const ref = (letter: string, workspace = 'workbench') =>
	snapshotUri(workspace, digest(letter), `/frames/${letter}.png`);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const manifest = (over: Record<string, unknown> = {}) => ({
	api: 1,
	sensor: 'bench-camera/camera',
	observations: [
		{
			at: '2026-10-03T10:00:00Z',
			parts: [
				{ kind: 'text', text: 'one frame' },
				{ kind: 'frame', file: digest('a'), mediaType: 'image/png' },
			],
		},
		{
			at: '2026-10-03T10:00:05Z',
			parts: [{ kind: 'frame', file: digest('b'), mediaType: 'image/jpeg' }],
		},
	],
	files: [
		{ digest: digest('a'), ref: ref('a') },
		{ digest: digest('b'), ref: ref('b') },
	],
	...over,
});

describe('the frames of a sensor manifest', () => {
	it('reads each frame with its time and media type, in order', () => {
		expect(parseManifestFrames(bytes(manifest()))).toEqual({
			sensor: 'bench-camera/camera',
			frames: [
				{ ref: ref('a'), at: '2026-10-03T10:00:00Z', mediaType: 'image/png' },
				{ ref: ref('b'), at: '2026-10-03T10:00:05Z', mediaType: 'image/jpeg' },
			],
		});
	});

	it('gives nothing for bytes that are not a version 1 manifest', () => {
		expect(parseManifestFrames(new TextEncoder().encode('not json'))).toBeUndefined();
		expect(parseManifestFrames(bytes([1, 2]))).toBeUndefined();
		expect(parseManifestFrames(bytes(manifest({ api: 2 })))).toBeUndefined();
		expect(parseManifestFrames(bytes(manifest({ sensor: 3 })))).toBeUndefined();
		expect(parseManifestFrames(bytes(manifest({ observations: 'x' })))).toBeUndefined();
	});

	it('skips a frame whose digest has no file entry, or whose ref is foreign', () => {
		const files = [
			{ digest: digest('a'), ref: 'file:///etc/passwd' },
			{ digest: digest('b'), ref: ref('b', 'other') },
		];
		expect(parseManifestFrames(bytes(manifest({ files })))?.frames).toEqual([]);
		const missing = [{ digest: digest('b'), ref: ref('b') }];
		expect(parseManifestFrames(bytes(manifest({ files: missing })))?.frames).toHaveLength(1);
		const wrong = [{ digest: digest('a'), ref: ref('b') }];
		expect(parseManifestFrames(bytes(manifest({ files: wrong })))?.frames).toEqual([]);
	});

	it('ignores parts that are not pictures, and malformed observations', () => {
		const observations = [
			null,
			{ parts: [] },
			{ at: 'x', parts: [{ kind: 'frame', file: digest('a'), mediaType: 'text/html' }] },
			{ at: 'y', parts: [{ kind: 'file', file: digest('a'), mediaType: 'image/png' }, 7] },
		];
		expect(parseManifestFrames(bytes(manifest({ observations })))?.frames).toEqual([]);
	});
});
