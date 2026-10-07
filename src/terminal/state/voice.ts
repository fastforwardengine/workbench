/** A press of Space shorter than this sends nothing. */
export const MIN_HOLD_MS = 300;

/** A hold stops at this length. A terminal that does not report key release never ends a hold by itself. */
export const MAX_HOLD_MS = 60_000;

/**
 * A terminal repeats a held key with no flag that says so. A Space that
 * comes within this time of the last one belongs to the hold in progress.
 * A key repeat starts after at most 2 s.
 */
export const HOLD_GAP_MS = 2_500;

/** What voice mode does now. */
export type VoicePhase = 'idle' | 'listening' | 'transcribing';

/** The part of a key event that voice mode reads. */
export interface VoiceKey {
	name: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	super?: boolean;
	hyper?: boolean;
	/** True when the terminal flags the key event as a repeat. Kitty and Ghostty send a repeat of a text key as plain text, with no flag. */
	repeated?: boolean;
}

/** One recording. */
export interface Take {
	/** The WAV file that the recording writes. */
	readonly file: string;
	/** Stop the recording and finish the file. */
	stop(): Promise<void>;
}

/** What voice mode needs from outside. A test passes fakes. */
export interface VoiceParts {
	/** A problem that stops voice mode from starting, with the fix, or undefined when voice mode can run. */
	ready(): Promise<string | undefined>;
	/** Start a recording. */
	start(): Promise<Take>;
	/** Start the transcriber, which loads the model. A second call changes nothing while it runs. */
	serve(): void;
	/** End the transcriber. */
	halt(): void;
	/** True while the transcriber loads the model. */
	loading(): boolean;
	/** Read the speech in a WAV file. It waits for the model. The signal cancels the work. */
	transcribe(file: string, signal: AbortSignal): Promise<string>;
	/** Delete a WAV file. */
	discard(file: string): Promise<void>;
	/** Name the person and the room that a message goes to now. */
	place(): string;
	/** Send the transcript as the person's message. */
	deliver(text: string): Promise<void>;
	/** Show a short note. */
	say(note: string): void;
	/** Show one line about a failure, or clear the line. */
	problem(line: string | undefined): void;
	/** The failure line that shows now. Voice mode clears only a line that it set. */
	shown(): string | undefined;
	/** The state changed. The terminal draws again. */
	changed(): void;
	/** The time in milliseconds. */
	now?: () => number;
}

/** The status line, by phase. */
const VOICE_LINE: Readonly<Record<VoicePhase, string>> = {
	idle: 'Voice: hold Space to talk. /voice returns to text.',
	listening: 'listening',
	transcribing: 'transcribing',
};

/** The status line while the model loads. A recording waits for the model. */
const LOADING_LINE: Readonly<Record<VoicePhase, string>> = {
	idle: 'Voice: loading model. You can hold Space to talk. /voice returns to text.',
	listening: 'listening',
	transcribing: 'loading model',
};

/** True for Space without a modifier. */
function isPlainSpace(key: VoiceKey): boolean {
	const modified = key.ctrl || key.meta || key.shift || key.super || key.hyper;
	return key.name === 'space' && !modified;
}

/** The first line of an error, as one line of at most 200 characters. */
export function oneLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const line = text.split('\n').find((part) => part.trim() !== '') ?? 'Unknown error';
	return line.trim().slice(0, 200);
}

/** A line of whisper output that names a sound, such as `[BLANK_AUDIO]` or `(wind blowing)`. */
const SOUND = /^(\[[^\]]*\]|\([^)]*\))$/;

/** The words in the output of whisper-server. A line that names a sound is not speech. */
export function cleanTranscript(output: string): string {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !SOUND.test(line))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Voice mode. The person holds Space on an empty composer to record, and
 * releases it to send what the recording says. This class holds the rules and
 * no device: the recorder and the transcriber come in as parts.
 */
export class Voice {
	/** True while voice mode is on. */
	on = false;
	phase: VoicePhase = 'idle';
	private readonly parts: VoiceParts;
	private readonly now: () => number;
	private pressedAt = 0;
	/** The time of the last Space that voice mode took. */
	private lastSpace = Number.NEGATIVE_INFINITY;
	/** True from the press that starts a recording to the release of Space. */
	private held = false;
	/** The failure line that voice mode put on screen. */
	private shownLine: string | undefined;
	private place = '';
	private job: Promise<Take | undefined> = Promise.resolve(undefined);
	/** Counts the recordings. A result from an older recording is stale. */
	private turn = 0;
	/** True while a recording closes. A new recording waits for it. */
	private settling = false;
	private checking = false;
	private abort: AbortController | undefined;
	private cap: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(parts: VoiceParts) {
		this.parts = parts;
		this.now = parts.now ?? Date.now;
	}

	/** The line that the status area shows. */
	get line(): string {
		return (this.parts.loading() ? LOADING_LINE : VOICE_LINE)[this.phase];
	}

	/**
	 * Read a key press. True when voice mode takes the key, so the composer
	 * does not type it. Space on an empty composer starts a recording. Space
	 * on a composer with text types a space, so the person can type `/voice`.
	 * The repeats of a held Space come until the release, and voice mode takes them all.
	 */
	press(key: VoiceKey, composerEmpty: boolean): boolean {
		if (!this.on || !isPlainSpace(key)) return false;
		const at = this.now();
		const holding = this.held && at - this.lastSpace <= HOLD_GAP_MS;
		this.lastSpace = at;
		if (holding || this.phase === 'listening') return true;
		if (!composerEmpty) return false;
		const free = this.phase === 'idle' && !this.settling && !this.disposed;
		if (free && !key.repeated) this.begin();
		return true;
	}

	/** Switch voice mode on or off. It starts only when the recorder and the model are ready. */
	async toggle(): Promise<void> {
		if (this.checking) return;
		if (this.on) {
			this.cancel();
			this.parts.halt();
			this.on = false;
			this.held = false;
			this.parts.changed();
			return;
		}
		this.checking = true;
		try {
			const problem = await this.parts.ready();
			if (problem) this.parts.say(problem);
			else this.turnOn();
		} finally {
			this.checking = false;
		}
		this.parts.changed();
	}

	/**
	 * The transcriber ended with no request to end it. Voice mode shows the
	 * line. The next recording starts the transcriber again.
	 */
	crashed(line: string): void {
		if (!this.on || this.disposed) return;
		this.report(line);
		this.parts.changed();
	}

	/** The person let go of Space. */
	async release(): Promise<void> {
		this.held = false;
		await this.stop();
	}

	/** End the recording, by a release or at the limit of a hold. */
	private async stop(): Promise<void> {
		if (this.phase !== 'listening') return;
		clearTimeout(this.cap);
		const turn = this.turn;
		const place = this.place;
		const tap = this.now() - this.pressedAt < MIN_HOLD_MS;
		this.phase = tap ? 'idle' : 'transcribing';
		this.parts.changed();
		const text = await this.settle(this.finish(turn, tap));
		if (text !== undefined) await this.deliver(text, place);
	}

	/** Drop the recording or the transcription. True when one ran. */
	cancel(): boolean {
		if (this.phase === 'idle') return false;
		const listening = this.phase === 'listening';
		this.stale();
		this.phase = 'idle';
		this.parts.changed();
		if (listening) void this.settle(this.drop(this.job));
		return true;
	}

	/** End all work, when the terminal ends. The recorder object ends with its device. */
	dispose(): void {
		this.disposed = true;
		this.stale();
		this.parts.halt();
	}

	private turnOn(): void {
		this.on = true;
		this.parts.serve();
	}

	private begin(): void {
		this.turn += 1;
		const turn = this.turn;
		this.phase = 'listening';
		this.pressedAt = this.now();
		this.place = this.parts.place();
		this.clearProblem();
		this.held = true;
		// The transcriber loads while the person talks. After a failure it starts again here.
		this.parts.serve();
		this.job = this.parts.start().then(
			(take) => take,
			(error) => {
				this.startFailed(turn, error);
				return undefined;
			},
		);
		this.cap = setTimeout(() => void this.stop(), MAX_HOLD_MS);
		this.parts.changed();
	}

	private startFailed(turn: number, error: unknown): void {
		if (turn !== this.turn || this.disposed) return;
		this.stale();
		this.phase = 'idle';
		this.report(`Cannot record: ${oneLine(error)}`);
		this.parts.changed();
	}

	private report(line: string): void {
		this.shownLine = line;
		this.parts.problem(line);
	}

	/** Clear the failure line, when voice mode put it there. */
	private clearProblem(): void {
		if (this.shownLine === undefined) return;
		if (this.parts.shown() === this.shownLine) this.parts.problem(undefined);
		this.shownLine = undefined;
	}

	/** Make the work of the open recording stale: its results go nowhere. */
	private stale(): void {
		this.turn += 1;
		clearTimeout(this.cap);
		this.abort?.abort();
		this.abort = undefined;
	}

	private async settle<T>(work: Promise<T>): Promise<T> {
		this.settling = true;
		try {
			return await work;
		} finally {
			this.settling = false;
		}
	}

	/** Stop a recording that nobody wants, and delete its file. */
	private async drop(job: Promise<Take | undefined>): Promise<void> {
		const take = await job;
		if (!take) return;
		await take.stop().catch(() => {});
		await this.parts.discard(take.file).catch(() => {});
	}

	/** Stop the recording, then read it unless it was a tap. It returns the words, or undefined when nothing is left to send. */
	private async finish(turn: number, tap: boolean): Promise<string | undefined> {
		const take = await this.job;
		if (!take) return undefined;
		let text: string | undefined;
		try {
			await take.stop();
			if (!tap && turn === this.turn) text = await this.read(take.file);
		} catch (error) {
			if (turn === this.turn && !this.disposed) this.report(oneLine(error));
		} finally {
			await this.parts.discard(take.file).catch(() => {});
		}
		if (turn !== this.turn || this.disposed) return undefined;
		this.phase = 'idle';
		this.parts.changed();
		return text;
	}

	private read(file: string): Promise<string> {
		this.abort = new AbortController();
		return this.parts.transcribe(file, this.abort.signal);
	}

	/** Send the transcript to the room that was open at the press, or drop it. */
	private async deliver(text: string, place: string): Promise<void> {
		if (text === '') {
			this.parts.say('No speech heard.');
		} else if (place !== this.parts.place()) {
			this.parts.say(`Dropped the transcript, because the room changed: ${text}`);
		} else {
			await this.parts.deliver(text);
		}
	}
}
