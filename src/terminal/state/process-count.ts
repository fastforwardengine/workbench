import type { Lab } from '../../host/host.ts';
import { coalesced } from './coalesce.ts';

type CountHost = Pick<Lab, 'processes' | 'watchProcesses'>;

/**
 * How many background processes of the specialists run, for the status row. It
 * lists the processes of the host once when it starts, and again after each
 * start and each end of a process. It uses no timer. A failed list keeps the
 * last count.
 */
export class ProcessCount {
	/** The processes that run. */
	running = 0;
	private unwatch: (() => void) | undefined;
	private closed = false;
	private readonly host: CountHost;
	private readonly changed: () => void;

	constructor(host: CountHost, changed: () => void) {
		this.host = host;
		this.changed = changed;
	}

	/** Watch the process table and read it. A second call does nothing. */
	start(): void {
		if (this.closed || this.unwatch) return;
		this.unwatch = this.host.watchProcesses(() => void this.read());
		void this.read();
	}

	/** Stop the watch for good. A read that lands later changes nothing. */
	dispose(): void {
		this.closed = true;
		this.unwatch?.();
		this.unwatch = undefined;
	}

	private readonly read = coalesced(async () => {
		try {
			const listed = await this.host.processes();
			const running = listed.filter((process) => process.state === 'running').length;
			if (this.closed || running === this.running) return;
			this.running = running;
			this.changed();
		} catch {
			// A failed list keeps the last count. The next start or end reads again.
		}
	});
}
