import { parseSnapshotUri } from '@ambionframework/ambion';
import { type FileContent, type ImageContent, isImagePath } from '../../host/files.ts';
import type { RefItem } from '../../view/refs.ts';

/** The most pictures that one strip holds. */
const STRIP_PICTURES = 4;

/** One strip under a message: the pictures of one snapshot ref, and one caption. */
export interface Strip {
	/** The snapshot ref that the strip came from. */
	ref: string;
	/** The first pictures of the ref, at most `STRIP_PICTURES`. */
	pictures: readonly ImageContent[];
	/** How many more pictures the ref holds. */
	more: number;
	/** The caption of the first frame, or the file name of an image. */
	caption: string;
}

/**
 * The snapshot refs of one message that can hold pictures: a sensor manifest
 * or an image file. The refs keep their order and appear once.
 */
export function pictureRefs(items: readonly RefItem[]): string[] {
	const refs = items.flatMap(({ resolved }) => {
		const target = resolved.target;
		if (target?.kind !== 'snapshot') return [];
		const path = parseSnapshotUri(target.ref)?.path ?? '';
		return path.endsWith('manifest.json') || isImagePath(path) ? [target.ref] : [];
	});
	return [...new Set(refs)];
}

/** The file name that a snapshot ref gives to its bytes. */
const nameOf = (ref: string): string => {
	const path = parseSnapshotUri(ref)?.path ?? ref;
	return path.slice(path.lastIndexOf('/') + 1);
};

/** The strip that a loaded snapshot makes, or `undefined` when it holds no picture. */
export function stripOf(ref: string, content: FileContent): Strip | undefined {
	if (content.frames && content.frames.length > 0) {
		const frames = content.frames;
		return {
			ref,
			pictures: frames.slice(0, STRIP_PICTURES).map((frame) => frame.image),
			more: Math.max(0, frames.length - STRIP_PICTURES),
			caption: frames[0]?.caption ?? '',
		};
	}
	if (content.image) return { ref, pictures: [content.image], more: 0, caption: nameOf(ref) };
	return undefined;
}

/** The strips of each message, by the seq of the message. A message without a loaded strip has no entry. */
export function stripsBySeq(
	items: readonly RefItem[],
	strip: (ref: string) => Strip | undefined,
): Map<number, Strip[]> {
	const bySeq = new Map<number, RefItem[]>();
	for (const item of items) bySeq.set(item.seq, [...(bySeq.get(item.seq) ?? []), item]);
	const out = new Map<number, Strip[]>();
	for (const [seq, own] of bySeq) {
		const strips = pictureRefs(own).flatMap((ref) => strip(ref) ?? []);
		if (strips.length > 0) out.set(seq, strips);
	}
	return out;
}

/** What identifies the strips of a message, without their bytes: for a signature. */
export const stripKey = (strip: Strip): [string, number, number, string] => [
	strip.ref,
	strip.pictures.length,
	strip.more,
	strip.caption,
];
