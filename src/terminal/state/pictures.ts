import { parseSnapshotUri } from '@ambionframework/ambion';
import { type FileContent, type ImageContent, isImagePath } from '../../host/files.ts';
import type { RefItem } from '../../view/refs.ts';

/** One thumbnail under a message: the picture of one snapshot ref, and its caption. */
export interface Strip {
	/** The snapshot ref that the picture came from. */
	ref: string;
	picture: ImageContent;
	/** The file name of the picture. */
	caption: string;
}

/** The snapshot refs of one message that name an image file. The refs keep their order and appear once. */
export function pictureRefs(items: readonly RefItem[]): string[] {
	const refs = items.flatMap(({ resolved }) => {
		const target = resolved.target;
		if (target?.kind !== 'snapshot') return [];
		const path = parseSnapshotUri(target.ref)?.path ?? '';
		return isImagePath(path) ? [target.ref] : [];
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
	return content.image ? { ref, picture: content.image, caption: nameOf(ref) } : undefined;
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
export const stripKey = (strip: Strip): [string, string] => [strip.ref, strip.caption];
