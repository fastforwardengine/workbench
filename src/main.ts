import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { describeUnavailable } from './domain/families.ts';
import { runEngine } from './terminal/tui.ts';

const USAGE = 'Usage: pnpm start [directory] [--as <person>]';

/**
 * Say which seats cannot run for want of a key. Workbench still
 * starts and runs the other seats. The terminal shows the same fact beside
 * each seat name.
 */
function reportMissingKeys(): void {
	for (const line of describeUnavailable()) {
		console.error(`${line} Set it in the environment or in .env.`);
	}
}

try {
	const { values, positionals } = parseArgs({
		options: { as: { type: 'string' } },
		allowPositionals: true,
	});
	if (positionals.length > 1) throw new Error(USAGE);
	reportMissingKeys();
	await runEngine({
		directory: positionals[0] ?? '.data',
		// Workbench adds a person named for this account (src/domain/definitions.ts),
		// so with no explicit choice it opens straight to that person.
		person: values.as ?? process.env.WORKBENCH_USER ?? userInfo().username,
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
