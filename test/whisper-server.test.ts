/**
 * The whisper-server process, against a fake that is a small Node HTTP server.
 * The fake answers `/health` and `/inference` like whisper.cpp does, and it
 * loads the model before it listens.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ServerTimes, WhisperServer } from '../src/terminal/app/whisper-server.ts';

/** What the fake does. */
interface Behavior {
	/** Milliseconds to load the model before the fake listens. */
	loadMs?: number;
	/** The fake ends at once with this line on standard error. */
	failToStart?: string;
	/** The fake ends with this line on standard error when it gets a request to `/inference`. */
	crashOnRequest?: string;
	/** Milliseconds that an inference takes. */
	inferMs?: number;
	/** The fake ignores SIGTERM. */
	ignoreTerm?: boolean;
	/** The status of the answer of `/inference`. */
	status?: number;
}

const SCRIPT = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const behavior = JSON.parse(process.env.FAKE_WHISPER ?? '{}');
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
appendFileSync(behavior.log, JSON.stringify({ pid: process.pid, args }) + '\\n');
if (behavior.ignoreTerm) process.on('SIGTERM', () => {});
if (behavior.failToStart) {
	console.error('loading the model');
	console.error(behavior.failToStart);
	process.exit(3);
}
const server = createServer((request, response) => {
	if (request.url === '/health') {
		response.end('{"status":"ok"}');
		return;
	}
	const chunks = [];
	request.on('data', (chunk) => chunks.push(chunk));
	request.on('end', () => {
		if (behavior.crashOnRequest) {
			console.error(behavior.crashOnRequest);
			process.exit(4);
		}
		const body = Buffer.concat(chunks).toString('latin1');
		const file = /name="file"[^\\r\\n]*\\r\\n(?:Content-Type:[^\\r\\n]*\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--/.exec(body)?.[1];
		const format = /name="response_format"\\r\\n\\r\\n([^\\r]*)/.exec(body)?.[1];
		setTimeout(() => {
			response.statusCode = behavior.status ?? 200;
			response.end(behavior.status ? '{"error":"no good"}' : \` heard: \${file} (\${format}) \\n\`);
		}, behavior.inferMs ?? 0);
	});
});
setTimeout(() => server.listen(Number(flag('--port')), flag('--host')), behavior.loadMs ?? 0);
`;

const folders: string[] = [];
const servers: WhisperServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const TIMES: ServerTimes = { poll: 20, load: 5_000, inference: 5_000, kill: 300 };

/** A fake whisper-server and a server object over it. */
function setup(behavior: Behavior = {}, times: Partial<ServerTimes> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'workbench-server-test-'));
	folders.push(root);
	const log = join(root, 'runs.jsonl');
	const script = join(root, 'fake.mjs');
	writeFileSync(script, SCRIPT);
	const command = join(root, 'whisper-server');
	const env = JSON.stringify({ ...behavior, log });
	writeFileSync(
		command,
		`#!/bin/sh\nFAKE_WHISPER='${env}' exec '${process.execPath}' '${script}' "$@"\n`,
	);
	chmodSync(command, 0o755);
	const wav = join(root, 'take.wav');
	writeFileSync(wav, 'hello wav');
	const events = { changed: 0, stopped: [] as string[] };
	const server = new WhisperServer(
		{ command, model: '/m.bin', custom: false, language: 'en' },
		{
			changed: () => {
				events.changed += 1;
			},
			stopped: (line) => events.stopped.push(line),
		},
		{ ...TIMES, ...times },
	);
	servers.push(server);
	/** The processes that the fake started, in order. */
	const runs = (): { pid: number; args: string[] }[] => {
		try {
			return readFileSync(log, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	return { server, wav, events, runs };
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Wait until the check passes. */
async function eventually(check: () => boolean, ms = 4_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('the condition did not hold');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const signal = () => new AbortController().signal;

describe('the start', () => {
	it('starts the process on a local port with the flags', async () => {
		const { server, runs, wav } = setup();
		server.start();
		await server.transcribe(wav, signal());
		const [run] = runs();
		expect(run?.args.slice(0, 4)).toEqual(['-m', '/m.bin', '--host', '127.0.0.1']);
		expect(run?.args).toContain('--port');
		expect(Number(run?.args[run.args.indexOf('--port') + 1])).toBeGreaterThan(0);
		expect(run?.args.slice(-5)).toEqual(['-nt', '-l', 'en', '-bs', '5']);
	});

	it('is loading until the model answers, then ready', async () => {
		const { server, events } = setup({ loadMs: 300 });
		expect(server.loading()).toBe(false);
		server.start();
		expect(server.loading()).toBe(true);
		await eventually(() => !server.loading());
		expect(events.changed).toBeGreaterThan(0);
	});

	it('starts one process for two calls', async () => {
		const { server, runs, wav } = setup();
		server.start();
		server.start();
		await server.transcribe(wav, signal());
		expect(runs()).toHaveLength(1);
	});
});

describe('a transcription', () => {
	it('waits for the model, then returns the cleaned words of the answer', async () => {
		const { server, wav } = setup({ loadMs: 300 });
		const started = Date.now();
		const text = await server.transcribe(wav, signal());
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(text).toBe('heard: hello wav (text)');
	});

	it('sends the file and the text format to the server', async () => {
		const { server, wav } = setup();
		expect(await server.transcribe(wav, signal())).toContain('hello wav (text)');
	});

	it('shows one line for an answer that is not 200', async () => {
		const { server, wav } = setup({ status: 500 });
		await expect(server.transcribe(wav, signal())).rejects.toThrow(
			/^whisper-server answered 500: no good$/,
		);
	});

	it('uses the same process for the next take', async () => {
		const { server, wav, runs } = setup();
		await server.transcribe(wav, signal());
		await server.transcribe(wav, signal());
		expect(runs()).toHaveLength(1);
	});

	it('stops waiting for the model when the signal fires', async () => {
		const { server, wav } = setup({ loadMs: 2_000 });
		const controller = new AbortController();
		const running = server.transcribe(wav, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('stops the request when the signal fires, and the server stays up', async () => {
		const { server, wav, runs } = setup({ inferMs: 2_000 });
		const controller = new AbortController();
		const running = server.transcribe(wav, controller.signal);
		await eventually(() => runs().length === 1);
		setTimeout(() => controller.abort(), 200);
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		expect(alive(runs()[0]?.pid ?? 0)).toBe(true);
	});

	it('fails with a line when the request runs too long, and ends the process', async () => {
		const { server, wav, events, runs } = setup({ inferMs: 2_000 }, { inference: 150 });
		await expect(server.transcribe(wav, signal())).rejects.toThrow(
			/^whisper-server ran longer than 0.15 s$/,
		);
		expect(events.stopped).toEqual(['whisper-server ran longer than 0.15 s']);
		await eventually(() => !alive(runs()[0]?.pid ?? 0));
	});
});

describe('a server that ends on its own', () => {
	it('reports one line with the last line of its standard error, and starts again at the next call', async () => {
		const { server, wav, events, runs } = setup({ failToStart: 'error: failed to load the model' });
		server.start();
		await eventually(() => events.stopped.length > 0);
		expect(events.stopped).toEqual(['whisper-server stopped: error: failed to load the model']);
		expect(server.loading()).toBe(false);
		await expect(server.transcribe(wav, signal())).rejects.toThrow(
			/^whisper-server stopped: error: failed to load the model$/,
		);
		expect(runs()).toHaveLength(2);
		expect(events.stopped).toHaveLength(2);
	});

	it('fails the take that a crash catches, and the next take gets a new process', async () => {
		const { server, wav, events, runs } = setup({ crashOnRequest: 'error: out of memory' });
		await expect(server.transcribe(wav, signal())).rejects.toThrow(/^whisper-server/);
		await eventually(() => events.stopped.length > 0);
		expect(events.stopped[0]).toBe('whisper-server stopped: error: out of memory');
		const first = runs()[0]?.pid ?? 0;
		await expect(server.transcribe(wav, signal())).rejects.toThrow(/^whisper-server/);
		expect(runs()).toHaveLength(2);
		expect(runs()[1]?.pid).not.toBe(first);
	});

	it('reports a program that is missing', async () => {
		const events = { stopped: [] as string[] };
		const server = new WhisperServer(
			{ command: '/nonexistent/whisper-server', model: '/m.bin', custom: false, language: 'en' },
			{ changed: () => {}, stopped: (line) => events.stopped.push(line) },
			TIMES,
		);
		servers.push(server);
		server.start();
		await eventually(() => events.stopped.length > 0);
		expect(events.stopped[0]).toMatch(/^whisper-server stopped: .*ENOENT/);
	});

	it('fails a run that cannot spawn, and starts again at the next call', async () => {
		const events = { stopped: [] as string[] };
		const server = new WhisperServer(
			{ command: 'whisper-server\0', model: '/m.bin', custom: false, language: 'en' },
			{ changed: () => {}, stopped: (line) => events.stopped.push(line) },
			TIMES,
		);
		servers.push(server);
		server.start();
		await eventually(() => events.stopped.length > 0);
		expect(events.stopped[0]).toMatch(/failed to start/);
		expect(server.loading()).toBe(false);
		server.start();
		await eventually(() => events.stopped.length > 1);
	});

	it('fails a server that does not load the model in time', async () => {
		const { server, events, runs } = setup({ loadMs: 5_000 }, { load: 200 });
		server.start();
		await eventually(() => events.stopped.length > 0);
		expect(events.stopped[0]).toBe('whisper-server did not load the model in 0.2 s');
		await eventually(() => !alive(runs()[0]?.pid ?? 0));
	});
});

describe('the end', () => {
	it('stops the process, and no process stays', async () => {
		const { server, wav, runs, events } = setup();
		await server.transcribe(wav, signal());
		const pid = runs()[0]?.pid ?? 0;
		expect(alive(pid)).toBe(true);
		await server.stop();
		expect(alive(pid)).toBe(false);
		expect(events.stopped).toEqual([]);
		expect(server.loading()).toBe(false);
	});

	it('stops a process that still loads the model', async () => {
		const { server, runs } = setup({ loadMs: 5_000 });
		server.start();
		await eventually(() => runs().length === 1);
		await server.stop();
		expect(alive(runs()[0]?.pid ?? 0)).toBe(false);
	});

	it('stops before the process starts', async () => {
		const { server, runs } = setup();
		server.start();
		await server.stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		for (const run of runs()) expect(alive(run.pid)).toBe(false);
	});

	it('sends SIGKILL to a process that ignores SIGTERM', async () => {
		const { server, wav, runs } = setup({ ignoreTerm: true });
		await server.transcribe(wav, signal());
		const pid = runs()[0]?.pid ?? 0;
		const started = Date.now();
		await server.stop();
		expect(alive(pid)).toBe(false);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
	});

	it('fails a take that waits for the model when the server stops', async () => {
		const { server, wav } = setup({ loadMs: 2_000 });
		const running = server.transcribe(wav, signal());
		await new Promise((resolve) => setTimeout(resolve, 100));
		// The take fails while `stop` waits for the process, so the test waits on it first.
		const failed = expect(running).rejects.toThrow(/^whisper-server stopped$/);
		await server.stop();
		await failed;
	});

	it('starts a new process after a stop, with none left from before', async () => {
		const { server, wav, runs } = setup();
		await server.transcribe(wav, signal());
		await server.stop();
		await server.transcribe(wav, signal());
		const [first, second] = runs();
		expect(alive(first?.pid ?? 0)).toBe(false);
		expect(alive(second?.pid ?? 0)).toBe(true);
		expect(first?.pid).not.toBe(second?.pid);
	});

	it('leaves no process after a quick stop and start', async () => {
		const { server, runs } = setup({ loadMs: 100 });
		server.start();
		void server.stop();
		server.start();
		await eventually(() => !server.loading());
		await server.stop();
		await new Promise((resolve) => setTimeout(resolve, 100));
		for (const run of runs()) expect(alive(run.pid)).toBe(false);
	});
});
