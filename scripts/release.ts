/**
 * Publish the head of `main` to npmjs from this machine, then tag the commit.
 *
 *   pnpm release                           # the npm login of this machine
 *   pnpm release --userconfig <npmrc>      # another npm configuration
 *
 * The script refuses a checkout that is not a clean `main` at `origin/main`.
 * It computes the version (scripts/release-version.ts), and refuses one that
 * is not above the `latest` version on npm. It checks, builds, and publishes
 * a clean worktree of HEAD, so the package holds exactly the commit. npm asks
 * for the sign-in in the browser. The script then pushes the tag
 * `v<version>`. Each argument goes to `npm publish`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAfter, releaseVersion } from './release-version.ts';

const NAME = '@fastforwardengine/workbench';

/** Run a command with the output on this terminal. */
const run = (command: string, args: readonly string[], cwd?: string): void => {
	execFileSync(command, args, { cwd, stdio: 'inherit' });
};

/** Run a command and return its output. */
const read = (command: string, args: readonly string[]): string =>
	execFileSync(command, args, { encoding: 'utf8' }).trim();

/** Fail unless the checkout is a clean `main` at the tip of `origin/main`. */
function assertReleasable(): void {
	if (read('git', ['status', '--porcelain']) !== '')
		throw new Error('Commit or stash the changes first.');
	if (read('git', ['branch', '--show-current']) !== 'main') throw new Error('Release from main.');
	run('git', ['fetch', '--quiet', 'origin', 'main']);
	if (read('git', ['rev-parse', 'HEAD']) !== read('git', ['rev-parse', 'origin/main']))
		throw new Error('Bring main level with origin/main first.');
}

/** The `latest` version on npm, or an empty string when npm holds none. */
function published(): string {
	try {
		return read('npm', ['view', NAME, 'version']);
	} catch {
		return '';
	}
}

/** The version of this release, above the published one. */
function nextVersion(): string {
	const { version: base } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
	const next = releaseVersion(
		base,
		Number(read('git', ['rev-list', '--count', 'HEAD'])),
		read('git', ['rev-parse', '--short=7', 'HEAD']),
	);
	assertAfter(next, published());
	return next;
}

/** Check, build, and publish a clean worktree of HEAD. */
function publish(version: string, npmArgs: readonly string[]): void {
	const worktree = mkdtempSync(join(tmpdir(), 'workbench-release-'));
	run('git', ['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
	try {
		run('pnpm', ['install', '--frozen-lockfile'], worktree);
		run('pnpm', ['run', 'check'], worktree);
		run('npm', ['version', version, '--no-git-tag-version'], worktree);
		run('pnpm', ['run', 'build'], worktree);
		// A version with a hash is a prerelease to npm, so the publish names the tag.
		run(
			'npm',
			['publish', '--access', 'public', '--tag', 'latest', '--auth-type', 'web', ...npmArgs],
			worktree,
		);
	} finally {
		run('git', ['worktree', 'remove', '--force', worktree]);
		rmSync(worktree, { recursive: true, force: true });
	}
}

function main(npmArgs: readonly string[]): void {
	assertReleasable();
	const version = nextVersion();
	process.stdout.write(`Release ${NAME}@${version}\n`);
	publish(version, npmArgs);
	run('git', ['tag', `v${version}`]);
	run('git', ['push', 'origin', `v${version}`]);
	process.stdout.write(`Published ${NAME}@${version}, and tagged v${version}.\n`);
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
