import { REF_LIMITS } from '@ambionframework/ambion';
import { isImagePath } from '../../host/files.ts';
import type { Attachment, Lab } from '../../host/host.ts';

/** One local file that `/attach` copied into the workspace, staged as a ref of the next message. */
export interface StagedAttachment {
	path: string;
	ref: string;
}

/** What `/attach` tells the terminal: a notice to say, or an error to show. */
export type AttachResult = { readonly notice: string } | { readonly error: unknown };

/**
 * Whatever the session's current `pendingRefs` is. The array is read when the
 * copy lands, not before it starts. A room switch that replaces the array
 * while `/attach` copies a file therefore loses nothing: the staged file lands
 * in the array that `pendingRefs` names by then.
 */
export interface AttachTarget {
	pendingRefs: StagedAttachment[];
}

const staged = ({ path, ref }: Attachment): StagedAttachment => ({ path, ref });

/**
 * The path that a paste names, when the composer can offer it to `/attach`: one
 * line, no whitespace inside, rooted at `/` or `~/`, and ending in the extension
 * of a picture. A pasted sentence, a paste of several lines, or a path to
 * another kind of file names none.
 */
export function pastedImagePath(text: string): string | undefined {
	const line = text.trim();
	if (line === '' || /\s/.test(line)) return undefined;
	if (!line.startsWith('/') && !line.startsWith('~/')) return undefined;
	return isImagePath(line) ? line : undefined;
}

/** Run `/attach`: copy a local file into the workspace, and stage it as a ref of the next message. */
export async function attachCommand(
	host: Pick<Lab, 'attach'>,
	target: AttachTarget,
	localPath: string,
): Promise<AttachResult> {
	if (!localPath.trim()) return { notice: 'Use /attach <local file path>.' };
	// A message holds a fixed number of refs, and a send with more fails every time.
	if (target.pendingRefs.length >= REF_LIMITS.count)
		return {
			notice: `A message holds up to ${REF_LIMITS.count} attachments. Send this message first, then attach the rest.`,
		};
	try {
		const attached = staged(await host.attach(localPath.trim()));
		target.pendingRefs.push(attached);
		return { notice: `Attached ${attached.path}. It goes with your next message.` };
	} catch (error) {
		return { error };
	}
}
