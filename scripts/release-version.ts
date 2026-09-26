/**
 * The version of a release: `<major>.<minor>.<count>-g<hash>`.
 *
 * - `<major>.<minor>` comes from `package.json`.
 * - `<count>` is the number of commits of HEAD. It increases with each
 *   commit on `main`, so each release has a higher version.
 * - `<hash>` is the short hash of HEAD. The `g` keeps the prerelease part
 *   valid when the hash starts with a zero.
 *
 *   node scripts/release-version.ts                  # print the version
 *   node scripts/release-version.ts --after 0.1.9-g1234abc
 *
 * With `--after`, the script fails when the version is not above the given
 * version, such as the version that npm holds as `latest`. An empty value
 * means that npm holds no version yet.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The number of commits in the version, or undefined for a version of another form. */
export function countOf(version: string): number | undefined {
	const match = /^\d+\.\d+\.(\d+)(?:-g[0-9a-f]+)?$/.exec(version);
	return match ? Number(match[1]) : undefined;
}

/** The version for a base such as `0.1.0`, a commit count, and a short hash. */
export function releaseVersion(base: string, count: number, hash: string): string {
	const [major, minor] = base.split('.');
	if (major === undefined || minor === undefined)
		throw new Error(`Base version ${base} has no minor.`);
	return `${major}.${minor}.${count}-g${hash}`;
}

/** Fail when `next` is not above `published`. An empty `published` accepts any version. */
export function assertAfter(next: string, published: string): void {
	if (published === '') return;
	const [before, after] = [countOf(published), countOf(next)];
	if (before === undefined)
		throw new Error(`The published version ${published} has no commit count.`);
	if (after === undefined || after <= before)
		throw new Error(`Version ${next} is not above the published version ${published}.`);
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();

function main(argv: readonly string[]): void {
	const { version: base } = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	) as { version: string };
	const next = releaseVersion(
		base,
		Number(git('rev-list', '--count', 'HEAD')),
		git('rev-parse', '--short=7', 'HEAD'),
	);
	const after = argv.indexOf('--after');
	if (after !== -1) assertAfter(next, argv[after + 1] ?? '');
	process.stdout.write(`${next}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
