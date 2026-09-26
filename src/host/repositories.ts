import { randomBytes } from 'node:crypto';
import { justGitBackend, sqliteGitStorage } from '@ambionframework/just-bash/git';
import { templateFiles, templates } from '../domain/templates.ts';

/**
 * The registration of each template of `src/domain/templates.ts`, by name.
 * Both git backends register it as `templates/<name>`. A change to the files
 * of a template updates it at the next start.
 */
export function templateRegistrations() {
	return Object.fromEntries(
		templates.map(({ name, description }) => [name, { description, source: templateFiles(name) }]),
	);
}

/**
 * The git backend of the lab on this machine. The storage is one SQLite
 * file, so a push survives a restart of the host.
 *
 * The backend signs each token with a secret of this process. The just-bash
 * `git` asks for a token at each request, so a new secret after a restart
 * loses nothing.
 */
export function labRepositories(location: string) {
	return justGitBackend({
		storage: sqliteGitStorage(location),
		secret: randomBytes(32).toString('hex'),
		templates: templateRegistrations(),
	});
}
