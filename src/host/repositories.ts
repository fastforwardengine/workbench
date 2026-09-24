import { randomBytes } from 'node:crypto';
import { gitBackend, sqliteGitStorage } from '@ambionframework/git';
import { templateFiles, templates } from '../domain/templates.ts';

/**
 * The git backend of the lab. It registers each template of
 * `src/domain/templates.ts` as `templates/<name>`. The storage is one SQLite
 * file, so a push survives a restart of the host.
 *
 * The backend signs each token with a secret of this process. The just-bash
 * `git` asks for a token at each request, so a new secret after a restart
 * loses nothing.
 */
export function labRepositories(location: string) {
	return gitBackend({
		storage: sqliteGitStorage(location),
		secret: randomBytes(32).toString('hex'),
		templates: Object.fromEntries(
			templates.map(({ name, description }) => [
				name,
				{ description, source: templateFiles(name) },
			]),
		),
	});
}
