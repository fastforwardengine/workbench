import type { ProcessStatus } from '@ambionframework/workspace';

/** How many characters of the command a post shows. */
const COMMAND_SHOWN = 80;

/** The host post that tells a seat its background process ended. */
export interface ProcessPost {
	/** The owner agent of the process. */
	to: string;
	text: string;
	/** One post for each process, also across a restart of the host. */
	key: string;
}

function outcome(process: ProcessStatus): string {
	switch (process.state) {
		case 'exited':
			return `finished with exit code ${process.exitCode ?? 'unknown'}`;
		case 'timed_out':
			return `stopped at its timeout of ${process.timeout} s`;
		case 'failed':
			return `failed: ${process.error ?? 'no reason recorded'}`;
		default:
			return process.state;
	}
}

const shown = (command: string): string => {
	const line = command.trim().split('\n')[0] ?? '';
	return line.length > COMMAND_SHOWN ? `${line.slice(0, COMMAND_SHOWN - 1)}…` : line;
};

/**
 * The post for a process that ended, or nothing. A cancel is a call of the
 * owner, whose result already tells the owner, so it gets no post. A process
 * that no room started has no room to post to.
 */
export function endedPost(process: ProcessStatus): ProcessPost | undefined {
	if (process.room === undefined || process.state === 'running' || process.state === 'cancelled')
		return undefined;
	const label = process.name ? `${process.name} (${process.handle})` : process.handle;
	return {
		to: process.agent,
		text:
			`Background process ${label} ${outcome(process)}. Command: ${shown(process.command)}. ` +
			`Read its output with status ${process.handle}. Stay silent if you already read it.`,
		key: `process-ended:${process.handle}`,
	};
}
