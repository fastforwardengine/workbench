import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { TracedStep } from '@ambionframework/ambion';

/** The name of the activation log, in the data directory. */
const ACTIVATION_LOG = 'activations.jsonl';

/** An append stream of the activation log. One line holds one `TracedStep`. */
export interface ActivationLog {
	/** Queue one line. The call never blocks and never throws. */
	write(traced: TracedStep): void;
	/** Write the queued lines and close the file. */
	close(): Promise<void>;
}

/**
 * Open `activations.jsonl` in `directory` for append. A write error drops the
 * line, because the log must not stop an activation.
 */
export function openActivationLog(directory: string): ActivationLog {
	const stream = createWriteStream(resolve(directory, ACTIVATION_LOG), { flags: 'a' });
	stream.on('error', () => {});
	return {
		write(traced) {
			try {
				stream.write(`${JSON.stringify(traced)}\n`);
			} catch {
				// A value that JSON cannot hold drops its line.
			}
		},
		close() {
			if (stream.closed || stream.destroyed) return Promise.resolve();
			return new Promise<void>((done) => {
				stream.once('close', () => done());
				stream.end();
			});
		},
	};
}
