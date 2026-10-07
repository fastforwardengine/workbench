/**
 * A timer that runs only while something needs it. `follow(true)` starts the
 * timer when it does not run, and `follow(false)` stops it. Both are cheap, so
 * a caller can make the call after each change.
 */
export class Ticker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly every: number;
	private readonly tick: () => void;

	constructor(every: number, tick: () => void) {
		this.every = every;
		this.tick = tick;
	}

	get running(): boolean {
		return this.timer !== undefined;
	}

	follow(wanted: boolean): void {
		if (wanted && !this.timer) {
			this.timer = setInterval(this.tick, this.every);
			this.timer.unref?.();
		} else if (!wanted && this.timer) this.stop();
	}

	/** Stop the timer. A later `follow(true)` starts it again. */
	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
