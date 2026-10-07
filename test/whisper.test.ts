/**
 * The whisper-server settings and the check before voice mode starts, against
 * a fake `whisper-server` that is a shell script in a temporary folder.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MODEL_URL,
	SERVER_HOST,
	serverArgs,
	whisperConfig,
	whisperProblem,
} from '../src/terminal/app/whisper.ts';

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
	const made = mkdtempSync(join(tmpdir(), 'workbench-whisper-test-'));
	folders.push(made);
	return made;
}

/** Write an executable `whisper-server` that runs a shell body. */
function fakeServer(bin: string, body: string): void {
	mkdirSync(bin, { recursive: true });
	const path = join(bin, 'whisper-server');
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

describe('the settings', () => {
	it('uses the large-v3 model in the cache folder by default', () => {
		const config = whisperConfig({}, '/home/priya');
		expect(config).toEqual({
			command: 'whisper-server',
			model: '/home/priya/.cache/whisper/ggml-large-v3.bin',
			custom: false,
			language: 'en',
		});
	});

	it('takes the language from WORKBENCH_WHISPER_LANGUAGE, and ignores a blank variable', () => {
		expect(whisperConfig({ WORKBENCH_WHISPER_LANGUAGE: 'auto' }, '/h').language).toBe('auto');
		expect(whisperConfig({ WORKBENCH_WHISPER_LANGUAGE: ' ' }, '/h').language).toBe('en');
	});

	it('takes the model from WORKBENCH_WHISPER_MODEL, with ~ for the home folder', () => {
		const config = whisperConfig(
			{ WORKBENCH_WHISPER_MODEL: '~/.cache/whisper/ggml-large-v3-turbo.bin' },
			'/home/priya',
		);
		expect(config.model).toBe('/home/priya/.cache/whisper/ggml-large-v3-turbo.bin');
		expect(config.custom).toBe(true);
	});

	it('takes an absolute path as it is, and ignores a blank variable', () => {
		expect(whisperConfig({ WORKBENCH_WHISPER_MODEL: '/models/m.bin' }, '/h').model).toBe(
			'/models/m.bin',
		);
		expect(whisperConfig({ WORKBENCH_WHISPER_MODEL: '  ' }, '/h').custom).toBe(false);
	});

	it('passes the model, a local address, the port, no timestamps, the language, and a beam of 5', () => {
		const args = serverArgs(
			{ command: 'whisper-server', model: '/m.bin', custom: false, language: 'en' },
			8123,
		);
		expect(SERVER_HOST).toBe('127.0.0.1');
		expect(args).toEqual([
			'-m',
			'/m.bin',
			'--host',
			'127.0.0.1',
			'--port',
			'8123',
			'-nt',
			'-l',
			'en',
			'-bs',
			'5',
		]);
	});
});

describe('the check before voice mode starts', () => {
	it('passes when whisper-server is on PATH and the model exists', async () => {
		const root = folder();
		fakeServer(join(root, 'bin'), 'true');
		writeFileSync(join(root, 'model.bin'), 'x');
		const config = {
			command: 'whisper-server',
			model: join(root, 'model.bin'),
			custom: false,
			language: 'en',
		};
		expect(await whisperProblem(config, join(root, 'bin'))).toBeUndefined();
	});

	it('names both fixes in one message when both are missing', async () => {
		const root = folder();
		const config = whisperConfig({}, root);
		const message = await whisperProblem(config, join(root, 'empty'));
		expect(message).toContain('brew install whisper-cpp');
		expect(message).toContain(`mkdir -p ${join(root, '.cache', 'whisper')}`);
		expect(message).toContain(`curl -L -o ${config.model} ${MODEL_URL}`);
		expect(MODEL_URL).toBe(
			'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
		);
		expect(message?.split('\n')[0]).toBe('Voice mode stays off.');
	});

	it('names only the missing model', async () => {
		const root = folder();
		fakeServer(join(root, 'bin'), 'true');
		const message = await whisperProblem(whisperConfig({}, root), join(root, 'bin'));
		expect(message).not.toContain('brew');
		expect(message).toContain('curl');
	});

	it('does not offer a download for a model that the person named', async () => {
		const root = folder();
		fakeServer(join(root, 'bin'), 'true');
		const config = whisperConfig({ WORKBENCH_WHISPER_MODEL: join(root, 'nope.bin') }, root);
		const message = await whisperProblem(config, join(root, 'bin'));
		expect(message).toContain('WORKBENCH_WHISPER_MODEL names a file that does not exist');
		expect(message).not.toContain('curl');
	});

	it('does not count a file that is not executable', async () => {
		const root = folder();
		mkdirSync(join(root, 'bin'));
		writeFileSync(join(root, 'bin', 'whisper-server'), 'x', { mode: 0o644 });
		writeFileSync(join(root, 'model.bin'), 'x');
		const config = {
			command: 'whisper-server',
			model: join(root, 'model.bin'),
			custom: false,
			language: 'en',
		};
		expect(await whisperProblem(config, join(root, 'bin'))).toContain('brew install whisper-cpp');
	});
});
