import { packageDirectory, packageFiles } from './package-root.ts';

/** The directory that holds the first files of the team notes. */
const notesDirectory = packageDirectory('notes');

/** The name of the notes repository: `shared/notes` on the git server. */
const NOTES = 'notes';

/** What `repos` shows for the notes. */
const DESCRIPTION =
	'The notes of the team: facts, decisions, and open questions of the FM radio bench, one claim per bullet with its source. Every specialist commits here. Start with README.md.';

/**
 * The registration of the notes as a shared repository. Ambion seeds the
 * repository once from these files, and the team owns it after that. An
 * eval of another project passes its own files.
 */
export function sharedRegistrations(
	files: Record<string, string> = packageFiles(notesDirectory, { text: true }),
) {
	return { [NOTES]: { description: DESCRIPTION, source: files } };
}
