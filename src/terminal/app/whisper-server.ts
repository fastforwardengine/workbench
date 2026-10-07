import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename } from 'node:path';
import { cleanTranscript, oneLine } from '../state/voice.ts';
import { SERVER_HOST, serverArgs, type WhisperConfig } from './whisper.ts';

/** The times of the server, in milliseconds. A test passes shorter ones. */
export interface ServerTimes {
	/** The wait between two readiness probes. */
	poll: number;
	/** The model must answer in this time, or the server counts as failed. */
	load: number;
	/** A transcription that runs longer than this counts as a failure. */
	inference: number;
	/** The wait between SIGTERM and SIGKILL. */
	kill: number;
}

const SERVER_TIMES: ServerTimes = {
	poll: 200,
	load: 120_000,
	inference: 120_000,
	kill: 3_000,
};

/** One readiness probe that gets no answer in this time has failed. */
const PROBE_TIMEOUT_MS = 1_000;

/** The server keeps this many characters of its last output. */
const TAIL_CHARS = 4_000;

/** What the terminal needs to know about the server. */
export interface ServerHooks {
	/** The server loaded the model, or ended. The terminal draws again. */
	changed(): void;
	/** The server ended with no request to end it. The line says why. */
	stopped(line: string): void;
}

/** One run of the whisper-server process. */
interface Instance {
	child: ChildProcess | undefined;
	port: number;
	/** Resolves when the model answers. Rejects when the process ends first. */
	ready: Promise<void>;
	loaded: boolean;
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

/** Ask the system for a free port on this computer. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, SERVER_HOST, () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
		});
	});
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const aborted = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/** Wait for the work, and stop waiting when the signal fires. The work itself goes on. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(aborted());
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/** The last line of some output, as at most 200 characters. */
function lastLine(output: string): string | undefined {
	const lines = output.split('\n').filter((line) => line.trim() !== '');
	return lines.at(-1)?.trim().slice(0, 200);
}

/** The message of an error body from the server, or the start of the body. */
function bodyMessage(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		const message = (parsed as { error?: unknown } | null)?.error;
		if (typeof message === 'string') return message;
	} catch {
		// The body is not JSON. The start of the text is the message.
	}
	return oneLine(body);
}

/** The reason of a failed request, with the system code when the request never reached the server. */
function requestLine(error: unknown): string {
	const cause = error instanceof Error ? error.cause : undefined;
	return cause instanceof Error ? oneLine(cause) : oneLine(error);
}

/**
 * The whisper-server process. It starts the process on a free port of this
 * computer, so the model loads once and stays loaded. `transcribe` posts a WAV
 * file to it. `stop` ends the process, and a process that ends on its own
 * calls `hooks.stopped` once.
 */
export class WhisperServer {
	private current: Instance | undefined;
	private readonly ending = new Set<Promise<void>>();
	private readonly config: WhisperConfig;
	private readonly hooks: ServerHooks;
	private readonly times: ServerTimes;
	private readonly name: string;

	constructor(config: WhisperConfig, hooks: ServerHooks, times: ServerTimes = SERVER_TIMES) {
		this.config = config;
		this.hooks = hooks;
		this.times = times;
		this.name = basename(config.command);
	}

	/** True while a process runs and the model is not loaded yet. */
	loading(): boolean {
		return this.current !== undefined && !this.current.loaded;
	}

	/** Start the process, when none runs. A second call changes nothing. */
	start(): void {
		this.run();
	}

	/**
	 * Read the speech in a WAV file. A process that is not running starts. The
	 * request waits for the model to load. The signal cancels the wait and the
	 * request. A failure is one line of text.
	 */
	async transcribe(file: string, signal: AbortSignal): Promise<string> {
		const instance = this.run();
		await until(instance.ready, signal);
		const form = new FormData();
		form.set('file', new Blob([await readFile(file)], { type: 'audio/wav' }), basename(file));
		form.set('response_format', 'text');
		const limit = AbortSignal.timeout(this.times.inference);
		let response: Response;
		let body: string;
		try {
			response = await fetch(`http://${SERVER_HOST}:${instance.port}/inference`, {
				method: 'POST',
				body: form,
				signal: AbortSignal.any([signal, limit]),
			});
			body = await response.text();
		} catch (error) {
			throw this.requestFailure(instance, error, signal, limit);
		}
		if (!response.ok)
			throw new Error(`${this.name} answered ${response.status}: ${bodyMessage(body)}`);
		return cleanTranscript(body);
	}

	/**
	 * End the process: SIGTERM, then SIGKILL after a short wait. It returns when
	 * every process that this class started has ended.
	 */
	async stop(): Promise<void> {
		const instance = this.current;
		this.current = undefined;
		if (instance) this.end(instance, new Error(`${this.name} stopped`));
		await Promise.all([...this.ending]);
	}

	private run(): Instance {
		if (this.current) return this.current;
		const instance = this.newInstance();
		this.current = instance;
		instance.ready = this.launch(instance);
		// A failed start reaches the person through `hooks.stopped`. Nobody may wait on `ready`.
		instance.ready.catch(() => {});
		return instance;
	}

	private newInstance(): Instance {
		let markEnded = () => {};
		const whenEnded = new Promise<void>((resolve) => {
			markEnded = resolve;
		});
		return {
			child: undefined,
			port: 0,
			ready: Promise.resolve(),
			loaded: false,
			failure: undefined,
			leaving: false,
			ended: false,
			tail: '',
			whenEnded,
			markEnded,
		};
	}

	private async launch(instance: Instance): Promise<void> {
		instance.port = await freePort();
		if (instance.failure) throw instance.failure;
		const child = spawn(this.config.command, serverArgs(this.config, instance.port), {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		instance.child = child;
		// A Workbench that ends with no chance to stop the server leaves no process.
		const reap = () => child.kill('SIGKILL');
		process.once('exit', reap);
		void instance.whenEnded.then(() => process.off('exit', reap));
		child.stderr.on('data', (chunk: Buffer) => {
			instance.tail = (instance.tail + chunk.toString()).slice(-TAIL_CHARS);
		});
		child.once('error', (error) => this.ended(instance, error.message));
		child.once('close', (code, signal) =>
			this.ended(instance, lastLine(instance.tail) ?? `it ended with ${signal ?? `code ${code}`}`),
		);
		await this.waitForModel(instance);
		instance.loaded = true;
		this.hooks.changed();
	}

	/** Probe the server until it answers. The model loads before the server listens. */
	private async waitForModel(instance: Instance): Promise<void> {
		const deadline = Date.now() + this.times.load;
		while (!(await this.answers(instance))) {
			if (instance.failure) throw instance.failure;
			if (Date.now() > deadline) {
				this.fail(instance, `${this.name} did not load the model in ${this.times.load / 1000} s`);
				throw instance.failure;
			}
			await sleep(this.times.poll);
		}
		if (instance.failure) throw instance.failure;
	}

	/**
	 * True when the server answers `/health` with anything but 503. A server
	 * that is still loading answers 503 or does not listen yet.
	 */
	private async answers(instance: Instance): Promise<boolean> {
		try {
			const response = await fetch(`http://${SERVER_HOST}:${instance.port}/health`, {
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			await response.body?.cancel();
			return response.status !== 503;
		} catch {
			return false;
		}
	}

	/** The process ended. A process that nobody asked to end is a failure. */
	private ended(instance: Instance, reason: string): void {
		instance.ended = true;
		instance.markEnded();
		if (!instance.leaving) this.fail(instance, `${this.name} stopped: ${reason}`);
	}

	/** Mark a run as failed, end its process, and tell the hooks once. */
	private fail(instance: Instance, line: string): void {
		if (instance.failure) return;
		if (this.current === instance) this.current = undefined;
		this.end(instance, new Error(line));
		this.hooks.stopped(line);
		this.hooks.changed();
	}

	/** Ask the process to end. SIGKILL follows when it does not end in time. */
	private end(instance: Instance, failure: Error): void {
		instance.failure ??= failure;
		instance.leaving = true;
		const child = instance.child;
		if (!child || instance.ended) return;
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), this.times.kill);
		const done = instance.whenEnded.then(() => clearTimeout(timer));
		this.ending.add(done);
		void done.then(() => this.ending.delete(done));
	}

	/** The error for a request that did not finish. */
	private requestFailure(
		instance: Instance,
		error: unknown,
		signal: AbortSignal,
		limit: AbortSignal,
	): Error {
		if (signal.aborted) return aborted();
		if (limit.aborted) {
			const line = `${this.name} ran longer than ${this.times.inference / 1000} s`;
			this.fail(instance, line);
			return new Error(line);
		}
		return instance.failure ?? new Error(`${this.name} failed: ${requestLine(error)}`);
	}
}
