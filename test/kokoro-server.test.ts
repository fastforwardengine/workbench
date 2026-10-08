/**
 * The koko process, against a fake that is a small Node HTTP server. The fake
 * answers `/v1/models` and `/v1/audio/speech` like Kokoros does.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KokoroConfig } from '../src/terminal/app/kokoro.ts';
import { KokoroServer } from '../src/terminal/app/kokoro-server.ts';
import type { ServerTimes } from '../src/terminal/app/whisper-server.ts';

const SCRIPT = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const behavior = JSON.parse(process.env.FAKE_KOKO ?? '{}');
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (behavior.failToStart) {
	console.error(behavior.failToStart);
	process.exit(3);
}
const server = createServer((request, response) => {
	if (request.url === '/v1/models') {
		response.end('{"data":[]}');
		return;
	}
	const chunks = [];
	request.on('data', (chunk) => chunks.push(chunk));
	request.on('end', () => {
		appendFileSync(behavior.log, JSON.stringify({ args, url: request.url, body: Buffer.concat(chunks).toString() }) + '\\n');
		response.statusCode = behavior.status ?? 200;
		response.end(behavior.status ? '{"error":"no good"}' : 'RIFFfake');
	});
});
setTimeout(() => server.listen(Number(flag('--port')), flag('--ip')), behavior.loadMs ?? 0);
`;

const folders: string[] = [];
const servers: KokoroServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const TIMES: ServerTimes = { poll: 20, load: 5_000, inference: 5_000, kill: 300 };

function setup(behavior: { failToStart?: string; status?: number; loadMs?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'workbench-kokoro-server-test-'));
	folders.push(root);
	const log = join(root, 'requests.jsonl');
	const script = join(root, 'fake.mjs');
	writeFileSync(script, SCRIPT);
	const command = join(root, 'koko');
	const env = JSON.stringify({ ...behavior, log });
	writeFileSync(
		command,
		`#!/bin/sh\nFAKE_KOKO='${env}' exec '${process.execPath}' '${script}' "$@"\n`,
	);
	chmodSync(command, 0o755);
	const config: KokoroConfig = {
		command,
		model: '/m.onnx',
		voices: '/v.bin',
		voice: 'af_heart',
	};
	const stopped: string[] = [];
	const server = new KokoroServer(
		config,
		{ changed: () => {}, stopped: (line) => stopped.push(line) },
		TIMES,
	);
	servers.push(server);
	const requests = (): { args: string[]; url: string; body: string }[] =>
		readFileSync(log, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	return { server, stopped, requests };
}

const signal = () => new AbortController().signal;

describe('KokoroServer', () => {
	it('starts on a free local port and posts one text for a WAV file', async () => {
		const { server, requests } = setup({ loadMs: 100 });
		const wav = await server.synthesize('The supply is on.', signal());
		expect(wav.toString()).toBe('RIFFfake');
		const [request] = requests();
		expect(request?.url).toBe('/v1/audio/speech');
		expect(JSON.parse(request?.body ?? '{}')).toEqual({
			model: 'tts-1',
			input: 'The supply is on.',
			voice: 'af_heart',
			response_format: 'wav',
		});
		expect(request?.args.slice(0, 13)).toEqual([
			'-m',
			'/m.onnx',
			'-d',
			'/v.bin',
			'-s',
			'af_heart',
			'--mono',
			'--instances',
			'1',
			'openai',
			'--ip',
			'127.0.0.1',
			'--port',
		]);
	});

	it('keeps one process for two texts', async () => {
		const { server, requests } = setup();
		await server.synthesize('One.', signal());
		await server.synthesize('Two.', signal());
		const ports = requests().map((request) => request.args.at(-1));
		expect(ports).toHaveLength(2);
		expect(ports[0]).toBe(ports[1]);
	});

	it('reports a status that is not 200 as one line', async () => {
		const { server } = setup({ status: 500 });
		await expect(server.synthesize('Hi.', signal())).rejects.toThrow(/koko answered 500: no good/);
	});

	it('reports a process that ends at the start', async () => {
		const { server, stopped } = setup({ failToStart: 'no model' });
		await expect(server.synthesize('Hi.', signal())).rejects.toThrow(/koko stopped: no model/);
		expect(stopped).toEqual(['koko stopped: no model']);
	});

	it('stops waiting when the signal fires', async () => {
		const { server } = setup({ loadMs: 2_000 });
		const abort = new AbortController();
		const work = server.synthesize('Hi.', abort.signal);
		setTimeout(() => abort.abort(), 50);
		await expect(work).rejects.toMatchObject({ name: 'AbortError' });
	});
});
