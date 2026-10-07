import type { Lab, ProcessOutput, ProcessView } from '../../host/host.ts';
import type { LiveProcess } from '../../view/live.ts';

type TailHost = Pick<Lab, 'processes' | 'processOutput'>;

/** While a seat of the open exchange runs, the tails read at this interval, in milliseconds. */
export const TAILS_MS = 1_000;

/** The most processes that one seat shows. */
export const MOST = 3;

const ESC = '\u001b';
const BEL = '\u0007';

/**
 * The escape sequences of a terminal: the CSI sequences, the OSC sequences,
 * the character set sequences such as `ESC ( B`, and the short ones.
 */
const SEQUENCE = new RegExp(
	`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[()*+][0-9A-Za-z]|${ESC}[@-Z\\\\-_]`,
	'g',
);

/** A line with each tab as a space and no other control character, C1 included. */
function plain(line: string): string {
	let text = '';
	for (const char of line) {
		const code = char.charCodeAt(0);
		if (char === '\t') text += ' ';
		else if (code >= 0x20 && (code < 0x7f || code > 0x9f)) text += char;
	}
	return text.trim();
}

/** The newest line of an output that holds a character, with the escape sequences taken out. */
export function newestLine(text: string): string {
	const lines = text.replace(SEQUENCE, '').split(/\r\n|\n|\r/);
	return lines.map(plain).findLast((line) => line !== '') ?? '';
}

/** A span of time as `m:ss`, or as `h:mm:ss` from one hour. */
export function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
	const two = (value: number) => String(value).padStart(2, '0');
	return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * The newest line of output of the background processes that the seats of
 * the open exchange run, for the live block. It reads nothing while no
 * activation runs. While one runs, it lists the processes of the host once
 * each interval, and reads the end of the output of each running process
 * that belongs to a running seat and to the open room. Each seat shows its
 * newest processes, up to `MOST`.
 */
export class ProcessTails {
	/** The lines of each seat, newest process first. */
	private lines = new Map<string, LiveProcess[]>();
	private room = '';
	private seats = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Counts each stop and each change of room, so a read that lands after one of them is dropped. */
	private generation = 0;
	private reading = false;
	/** True after `dispose`. A disposed tails object starts no timer again. */
	private closed = false;
	private readonly host: TailHost;
	private readonly changed: () => void;
	private readonly now: () => number;

	/** `changed` runs after the lines change. */
	constructor(host: TailHost, changed: () => void, now: () => number = Date.now) {
		this.host = host;
		this.changed = changed;
		this.now = now;
	}

	/** The lines of the processes of one seat, newest first. It is empty while the seat has none. */
	get bySeat(): ReadonlyMap<string, readonly LiveProcess[]> {
		return this.lines;
	}

	/**
	 * Follow the seats that run in the open exchange of `room`. Call it after
	 * each read of the room. With no seat, it stops the reads and drops the lines.
	 */
	watch(room: string, seats: readonly string[]): void {
		if (this.closed) return;
		if (seats.length === 0) {
			this.stop();
			return;
		}
		if (room !== this.room) this.reset(room);
		this.seats = new Set(seats);
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll(), TAILS_MS);
		this.timer.unref?.();
		void this.poll();
	}

	/** Stop the reads and drop the lines. A later `watch` starts them again. */
	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.reset('');
	}

	/**
	 * Stop the reads for good. A room read that lands after the person leaves
	 * calls `watch`, and `watch` then starts nothing.
	 */
	dispose(): void {
		this.closed = true;
		this.stop();
	}

	private reset(room: string): void {
		this.generation += 1;
		this.room = room;
		this.seats = new Set();
		this.lines = new Map();
	}

	/** The running processes of the open room that a running seat owns, newest first, up to `MOST` for each seat. */
	private chosen(listed: readonly ProcessView[]): ProcessView[] {
		const own = listed
			.filter(
				(process) =>
					process.state === 'running' &&
					process.room === this.room &&
					this.seats.has(process.agent),
			)
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
		const taken = new Map<string, number>();
		return own.filter((process) => {
			const count = taken.get(process.agent) ?? 0;
			taken.set(process.agent, count + 1);
			return count < MOST;
		});
	}

	private async poll(): Promise<void> {
		if (this.reading) return;
		this.reading = true;
		const generation = this.generation;
		try {
			const listed = await this.host.processes();
			const chosen = this.chosen(listed);
			const outputs = await Promise.all(
				chosen.map((process) =>
					this.host.processOutput(process.handle, process.agent).catch(() => undefined),
				),
			);
			if (generation === this.generation) this.take(chosen, outputs);
		} catch {
			// A failed list keeps the last lines. The next tick reads again.
		} finally {
			this.reading = false;
		}
	}

	private take(
		chosen: readonly ProcessView[],
		outputs: readonly (ProcessOutput | undefined)[],
	): void {
		const next = new Map<string, LiveProcess[]>();
		const now = this.now();
		chosen.forEach((process, at) => {
			const line = newestLine(outputs[at]?.text ?? '');
			const runs = clock(now - Date.parse(process.startedAt));
			const own = next.get(process.agent) ?? [];
			own.push({ name: process.name ?? process.handle, runs, line });
			next.set(process.agent, own);
		});
		if (JSON.stringify([...next]) === JSON.stringify([...this.lines])) return;
		this.lines = next;
		this.changed();
	}
}
