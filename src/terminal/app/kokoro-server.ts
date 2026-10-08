import { type ChildProcess, spawn } from 'node:child_process';
import { basename } from 'node:path';
import { oneLine } from '../state/voice.ts';
import { type KokoroConfig, kokoroArgs } from './kokoro.ts';
import { SERVER_HOST } from './whisper.ts';
import {
	aborted,
	bodyMessage,
	freePort,
	lastLine,
	PROBE_TIMEOUT_MS,
	requestLine,
	type ServerHooks,
	type ServerTimes,
	sleep,
	TAIL_CHARS,
	until,
} from './whisper-server.ts';

/** The times of the server. A reply is short, so a request has less time than a transcription has. */
const KOKORO_TIMES: ServerTimes = {
	poll: 200,
	load: 60_000,
	inference: 30_000,
	kill: 3_000,
};

/**
 * The speed of the speech. Kokoro makes the speech shorter at the same pitch.
 * 1 is the speed of the model, and 1.2 is 20% faster.
 */
const SPEECH_SPEED = 1.2;

/** One run of the `koko` process. */
interface Run {
	child: ChildProcess | undefined;
	port: number;
	/** Resolves when the server answers. Rejects when the process ends first. */
	ready: Promise<void>;
	/** The reason that this run ended or was told to end, or undefined while it runs. */
	failure: Error | undefined;
	/** True after this class asked the process to end. */
	leaving: boolean;
	/** True after the process ended. */
	ended: boolean;
	/** The end of the standard error of the process. */
	tail: string;
	/** Resolves when the process ended. */
	whenEnded: Promise<void>;
	markEnded: () => void;
}

/**
 * The `koko` process in server mode. It starts on a free port of this
 * computer, so the model loads once and stays loaded. `synthesize` posts one
 * text to the OpenAI speech route and returns a WAV file. `stop` ends the
 * process, and a process that ends on its own calls `hooks.stopped` once.
 */
export class KokoroServer {
	private current: Run | undefined;
	private readonly ending = new Set<Promise<void>>();
	private readonly config: KokoroConfig;
	private readonly hooks: ServerHooks;
	private readonly times: ServerTimes;
	private readonly name: string;

	constructor(config: KokoroConfig, hooks: ServerHooks, times: ServerTimes = KOKORO_TIMES) {
		this.config = config;
		this.hooks = hooks;
		this.times = times;
		this.name = basename(config.command);
	}

	/** Start the process, when none runs. A second call changes nothing. */
	start(): void {
		this.run();
	}

	/**
	 * Turn one text into a WAV file. A process that is not running starts. The
	 * request waits for the model to load. The signal cancels the wait and the
	 * request. A failure is one line of text.
	 */
	async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
		const run = this.run();
		await until(run.ready, signal);
		const limit = AbortSignal.timeout(this.times.inference);
		let response: Response;
		let bytes: Buffer;
		try {
			response = await fetch(`http://${SERVER_HOST}:${run.port}/v1/audio/speech`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model: 'tts-1',
					input: text,
					voice: this.config.voice,
					response_format: 'wav',
					speed: SPEECH_SPEED,
				}),
				signal: AbortSignal.any([signal, limit]),
			});
			bytes = Buffer.from(await response.arrayBuffer());
		} catch (error) {
			throw this.requestFailure(run, error, signal, limit);
		}
		if (!response.ok)
			throw new Error(`${this.name} answered ${response.status}: ${bodyMessage(bytes.toString())}`);
		return bytes;
	}

	/**
	 * End the process: SIGTERM, then SIGKILL after a short wait. It returns when
	 * every process that this class started has ended.
	 */
	async stop(): Promise<void> {
		const run = this.current;
		this.current = undefined;
		if (run) this.end(run, new Error(`${this.name} stopped`));
		await Promise.all([...this.ending]);
	}

	private run(): Run {
		if (this.current) return this.current;
		const run = this.newRun();
		this.current = run;
		run.ready = this.launch(run).catch((error: unknown) => {
			this.fail(run, `${this.name} failed to start: ${oneLine(error)}`);
			throw run.failure ?? error;
		});
		// A failed start reaches the person through `hooks.stopped`. Nobody may wait on `ready`.
		run.ready.catch(() => {});
		return run;
	}

	private newRun(): Run {
		let markEnded = () => {};
		const whenEnded = new Promise<void>((resolve) => {
			markEnded = resolve;
		});
		return {
			child: undefined,
			port: 0,
			ready: Promise.resolve(),
			failure: undefined,
			leaving: false,
			ended: false,
			tail: '',
			whenEnded,
			markEnded,
		};
	}

	private async launch(run: Run): Promise<void> {
		run.port = await freePort();
		if (run.failure) throw run.failure;
		const child = spawn(this.config.command, kokoroArgs(this.config, run.port), {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		run.child = child;
		// A Workbench that ends in a normal way stops the server here. SIGKILL or a native crash of Workbench leaves it.
		const reap = () => child.kill('SIGKILL');
		process.once('exit', reap);
		void run.whenEnded.then(() => process.off('exit', reap));
		child.stderr.on('data', (chunk: Buffer) => {
			run.tail = (run.tail + chunk.toString()).slice(-TAIL_CHARS);
		});
		child.once('error', (error) => this.ended(run, error.message));
		child.once('close', (code, signal) =>
			this.ended(run, lastLine(run.tail) ?? `it ended with ${signal ?? `code ${code}`}`),
		);
		await this.waitForModel(run);
		this.hooks.changed();
	}

	/** Probe the server until it answers. The model loads before the server listens. */
	private async waitForModel(run: Run): Promise<void> {
		const deadline = Date.now() + this.times.load;
		while (!(await this.answers(run))) {
			if (run.failure) throw run.failure;
			if (Date.now() > deadline) {
				this.fail(run, `${this.name} did not load the model in ${this.times.load / 1000} s`);
				throw run.failure;
			}
			await sleep(this.times.poll);
		}
		if (run.failure) throw run.failure;
	}

	/** True when the server answers `/v1/models`. */
	private async answers(run: Run): Promise<boolean> {
		try {
			const response = await fetch(`http://${SERVER_HOST}:${run.port}/v1/models`, {
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			await response.body?.cancel();
			return response.ok;
		} catch {
			return false;
		}
	}

	/** The process ended. A process that nobody asked to end is a failure. */
	private ended(run: Run, reason: string): void {
		run.ended = true;
		run.markEnded();
		if (!run.leaving) this.fail(run, `${this.name} stopped: ${reason}`);
	}

	/** Mark a run as failed, end its process, and tell the hooks once. */
	private fail(run: Run, line: string): void {
		if (run.failure) return;
		if (this.current === run) this.current = undefined;
		this.end(run, new Error(line));
		this.hooks.stopped(line);
		this.hooks.changed();
	}

	/** Ask the process to end. SIGKILL follows when it does not end in time. */
	private end(run: Run, failure: Error): void {
		run.failure ??= failure;
		run.leaving = true;
		const child = run.child;
		if (!child || run.ended) return;
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), this.times.kill);
		const done = run.whenEnded.then(() => clearTimeout(timer));
		this.ending.add(done);
		void done.then(() => this.ending.delete(done));
	}

	/** The error for a request that did not finish. */
	private requestFailure(run: Run, error: unknown, signal: AbortSignal, limit: AbortSignal): Error {
		if (signal.aborted) return aborted();
		if (limit.aborted) {
			const line = `${this.name} ran longer than ${this.times.inference / 1000} s`;
			this.fail(run, line);
			return new Error(line);
		}
		return run.failure ?? new Error(`${this.name} failed: ${requestLine(error)}`);
	}
}
