/**
 * The whisper-cli settings and the process, against a fake `whisper-cli` that
 * is a shell script in a temporary folder.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MODEL_URL,
	transcribe,
	whisperArgs,
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

/** Write an executable `whisper-cli` that runs a shell body. */
function fakeCli(bin: string, body: string): void {
	mkdirSync(bin, { recursive: true });
	const path = join(bin, 'whisper-cli');
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

describe('the settings', () => {
	it('uses the large-v3 model in the cache folder by default', () => {
		const config = whisperConfig({}, '/home/priya');
		expect(config).toEqual({
			command: 'whisper-cli',
			model: '/home/priya/.cache/whisper/ggml-large-v3.bin',
			custom: false,
		});
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

	it('passes the model, the file, no timestamps, no prints, any language, and a beam of 5', () => {
		const args = whisperArgs({ command: 'whisper-cli', model: '/m.bin', custom: false }, '/t.wav');
		expect(args).toEqual([
			'-m',
			'/m.bin',
			'-f',
			'/t.wav',
			'-nt',
			'-np',
			'-l',
			'auto',
			'-bs',
			'5',
			'-bo',
			'5',
		]);
	});
});

describe('the check before voice mode starts', () => {
	it('passes when whisper-cli is on PATH and the model exists', async () => {
		const root = folder();
		fakeCli(join(root, 'bin'), 'true');
		writeFileSync(join(root, 'model.bin'), 'x');
		const config = { command: 'whisper-cli', model: join(root, 'model.bin'), custom: false };
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
		fakeCli(join(root, 'bin'), 'true');
		const message = await whisperProblem(whisperConfig({}, root), join(root, 'bin'));
		expect(message).not.toContain('brew');
		expect(message).toContain('curl');
	});

	it('does not offer a download for a model that the person named', async () => {
		const root = folder();
		fakeCli(join(root, 'bin'), 'true');
		const config = whisperConfig({ WORKBENCH_WHISPER_MODEL: join(root, 'nope.bin') }, root);
		const message = await whisperProblem(config, join(root, 'bin'));
		expect(message).toContain('WORKBENCH_WHISPER_MODEL names a file that does not exist');
		expect(message).not.toContain('curl');
	});

	it('does not count a file that is not executable', async () => {
		const root = folder();
		mkdirSync(join(root, 'bin'));
		writeFileSync(join(root, 'bin', 'whisper-cli'), 'x', { mode: 0o644 });
		writeFileSync(join(root, 'model.bin'), 'x');
		const config = { command: 'whisper-cli', model: join(root, 'model.bin'), custom: false };
		expect(await whisperProblem(config, join(root, 'bin'))).toContain('brew install whisper-cpp');
	});
});

describe('the process', () => {
	async function run(body: string, signal = new AbortController().signal) {
		const root = folder();
		const bin = join(root, 'bin');
		fakeCli(bin, body);
		const config = { command: join(bin, 'whisper-cli'), model: '/m.bin', custom: false };
		return transcribe(config, '/t.wav', signal);
	}

	it('returns the words from stdout, trimmed', async () => {
		expect(await run('printf " Set the supply to five volts.\\n\\n"')).toBe(
			'Set the supply to five volts.',
		);
	});

	it('gets the flags that the settings build', async () => {
		expect(await run('echo "$@"')).toBe('-m /m.bin -f /t.wav -nt -np -l auto -bs 5 -bo 5');
	});

	it('returns an empty string for silence', async () => {
		expect(await run('echo " [BLANK_AUDIO]"')).toBe('');
	});

	it('fails with one line: the last line of stderr', async () => {
		const failure = run('echo "loading" >&2; echo "error: failed to read the model" >&2; exit 3');
		await expect(failure).rejects.toThrow(/^whisper-cli failed: error: failed to read the model$/);
		await expect(failure).rejects.not.toThrow(/\n/);
	});

	it('fails with one line when the program is missing', async () => {
		const config = { command: '/nonexistent/whisper-cli', model: '/m.bin', custom: false };
		const failure = transcribe(config, '/t.wav', new AbortController().signal);
		await expect(failure).rejects.toThrow(/^whisper-cli failed: .*ENOENT/);
	});

	it('stops the process when the signal fires', async () => {
		const controller = new AbortController();
		const running = run('sleep 30', controller.signal);
		setTimeout(() => controller.abort(), 100);
		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
	});
});
