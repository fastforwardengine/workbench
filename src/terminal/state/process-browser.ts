import type { Lab, ProcessOutput, ProcessView } from '../../host/host.ts';
import { errorText } from '../../view/text.ts';

type ProcessHost = Pick<Lab, 'processes' | 'processOutput' | 'cancelProcess' | 'watchProcesses'>;

/** While the chosen process runs, the panel reads the end of its output at this interval, in milliseconds. */
export const FOLLOW_MS = 1_000;

/**
 * The processes panel, without drawing: the background processes of the
 * seats, the chosen one, and the end of its output. The output loads as the
 * selection moves. While the panel is open, a start or an end of a process
 * reads the list again. While the panel is open and the chosen process runs,
 * a timer reads the end of the output once each interval.
 */
export class ProcessBrowser {
	open = false;
	index = 0;
	processes: ProcessView[] = [];
	/** The end of the output of the chosen process, once it loads. */
	output: ProcessOutput | undefined;
	/** Why the list or the output did not load. */
	problem: string | undefined;
	/** The handle that the first cancel key chose. A second cancel key stops it. */
	confirming: string | undefined;
	/** The handles with a cancel that has not ended. */
	readonly cancelling = new Set<string>();
	/** A short message for the hint line, such as the result of a cancel. */
	message: string | undefined;
	private token = 0;
	/** Counts each open and each close, so a read that lands after one of them is dropped. */
	private generation = 0;
	private unwatch: (() => void) | undefined;
	private follower: ReturnType<typeof setInterval> | undefined;
	/** How many output reads are in flight. A timer tick skips while one runs. */
	private reading = 0;
	private readonly host: ProcessHost;
	private readonly changed: () => void;

	constructor(host: ProcessHost, changed: () => void) {
		this.host = host;
		this.changed = changed;
	}

	get selected(): ProcessView | undefined {
		return this.processes[this.index];
	}

	/** Open the panel on the newest process, and read the list again on each start and end. */
	async show(): Promise<void> {
		this.index = 0;
		this.processes = [];
		this.problem = undefined;
		this.output = undefined;
		this.confirming = undefined;
		this.message = undefined;
		await this.resume();
	}

	/** Open the panel again on the list and the choice that `hide` left, and read the list again. */
	async resume(): Promise<void> {
		this.open = true;
		this.generation += 1;
		this.unwatch?.();
		this.unwatch = this.host.watchProcesses(() => void this.refresh());
		await this.refresh();
	}

	hide(): void {
		this.open = false;
		this.generation += 1;
		this.token += 1;
		this.unwatch?.();
		this.unwatch = undefined;
		this.unfollow();
		this.changed();
	}

	/** Stop the timer, so a terminal that ends leaves no timer. `hide` also stops it. */
	dispose(): void {
		this.unfollow();
	}

	move(step: number): void {
		const last = this.processes.length - 1;
		if (last < 0) return;
		this.index = Math.max(0, Math.min(last, this.index + step));
		this.confirming = undefined;
		this.message = undefined;
		void this.load();
	}

	/**
	 * Read the list again. The selection stays on the process that is chosen
	 * when the list arrives, so a move during the read holds.
	 */
	async refresh(): Promise<void> {
		if (!this.open) return;
		const generation = this.generation;
		let listed: ProcessView[] | undefined;
		let problem: string | undefined;
		try {
			listed = await this.host.processes();
		} catch (error) {
			problem = errorText(error);
		}
		if (generation !== this.generation) return;
		this.problem = problem;
		if (listed) this.choose(listed);
		await this.load();
	}

	/** Take a new list, and keep the chosen process when the list still holds it. */
	private choose(listed: ProcessView[]): void {
		const chosen = this.selected?.handle;
		this.processes = listed;
		const at = listed.findIndex((process) => process.handle === chosen);
		this.index = at === -1 ? Math.min(this.index, Math.max(0, listed.length - 1)) : at;
	}

	/**
	 * The first press chooses the process, and the second press stops it. A
	 * process that has ended, or that has a cancel in progress, takes no cancel.
	 */
	async cancel(): Promise<void> {
		const process = this.selected;
		if (!process) return;
		if (process.state !== 'running') return this.say(`${label(process)} is not running.`);
		if (this.cancelling.has(process.handle)) return this.say(`Cancelling ${label(process)}.`);
		if (this.confirming !== process.handle) {
			this.confirming = process.handle;
			return this.say(`Press x again to cancel ${label(process)}.`);
		}
		this.confirming = undefined;
		this.cancelling.add(process.handle);
		this.say(`Cancelling ${label(process)}.`);
		try {
			const ended = await this.host.cancelProcess(process.handle);
			this.message =
				ended.state === 'running'
					? `${label(ended)} did not end within 10 seconds.`
					: `${label(ended)} is ${ended.state.replace('_', ' ')}.`;
		} catch (error) {
			this.message = errorText(error);
		} finally {
			this.cancelling.delete(process.handle);
		}
		await this.refresh();
	}

	private say(message: string): void {
		this.message = message;
		this.changed();
	}

	/** Run the timer while the panel is open and the chosen process runs. Stop it otherwise. */
	private follow(): void {
		if (this.open && this.selected?.state === 'running')
			this.follower ??= setInterval(() => this.tick(), FOLLOW_MS);
		else this.unfollow();
	}

	private unfollow(): void {
		clearInterval(this.follower);
		this.follower = undefined;
	}

	/** Read the output again, unless the last read still runs. */
	private tick(): void {
		if (this.reading === 0) void this.load();
	}

	private async load(): Promise<void> {
		this.token += 1;
		const mine = this.token;
		const process = this.selected;
		this.follow();
		if (!this.open) return;
		if (!process) {
			this.output = undefined;
			this.changed();
			return;
		}
		this.reading += 1;
		try {
			const output = await this.host.processOutput(process.handle, process.agent);
			if (mine !== this.token) return;
			this.output = output;
			this.problem = undefined;
		} catch (error) {
			if (mine !== this.token) return;
			this.output = undefined;
			this.problem = errorText(error);
		} finally {
			this.reading -= 1;
		}
		this.changed();
	}
}

/** The name and the handle of a process, or the handle alone. */
export function label(process: ProcessView): string {
	return process.name ? `${process.name} (${process.handle})` : process.handle;
}

/** A span of time, such as `2m 14s` or `1h 3m`. */
function span(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
	if (h > 0) return `${h}h ${m}m`;
	return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The state of a process in a few words: `running 2m 14s`, `exit 0 after 3s`,
 * or `cancelled after 1m 2s`. An ended process whose files name no end time
 * gives the state alone.
 */
export function stateText(process: ProcessView, now: number): string {
	const end = process.endedAt === undefined ? now : Date.parse(process.endedAt);
	const took = span(end - Date.parse(process.startedAt));
	if (process.state !== 'running' && process.endedAt === undefined && process.state !== 'failed')
		return process.state === 'exited'
			? `exit ${process.exitCode ?? '?'}`
			: process.state.replace('_', ' ');
	switch (process.state) {
		case 'running':
			return `running ${took}`;
		case 'exited':
			return `exit ${process.exitCode ?? '?'} after ${took}`;
		case 'failed':
			return `failed: ${process.error ?? 'the backend failed'}`;
		default:
			return `${process.state.replace('_', ' ')} after ${took}`;
	}
}
