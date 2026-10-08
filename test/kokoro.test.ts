import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	kokoroArgs,
	kokoroConfig,
	kokoroProblem,
	playerCommand,
} from '../src/terminal/app/kokoro.ts';

describe('kokoroConfig', () => {
	it('puts the model files in the cache folder of the home folder', () => {
		const config = kokoroConfig({}, '/home/p');
		expect(config.command).toBe('/home/p/.cache/kokoro/bin/koko');
		expect(config.model).toBe('/home/p/.cache/kokoro/kokoro-v1.0.onnx');
		expect(config.voices).toBe('/home/p/.cache/kokoro/voices-v1.0.bin');
		expect(config.voice).toBe('af_heart');
	});

	it('takes another voice from WORKBENCH_KOKORO_VOICE', () => {
		expect(kokoroConfig({ WORKBENCH_KOKORO_VOICE: ' bf_emma ' }, '/h').voice).toBe('bf_emma');
		expect(kokoroConfig({ WORKBENCH_KOKORO_VOICE: ' ' }, '/h').voice).toBe('af_heart');
	});
});

describe('kokoroArgs', () => {
	it('puts the global arguments before the subcommand, and binds to the local address', () => {
		const args = kokoroArgs(kokoroConfig({}, '/h'), 4321);
		expect(args).toEqual([
			'-m',
			'/h/.cache/kokoro/kokoro-v1.0.onnx',
			'-d',
			'/h/.cache/kokoro/voices-v1.0.bin',
			'-s',
			'af_heart',
			'--mono',
			'--instances',
			'1',
			'openai',
			'--ip',
			'127.0.0.1',
			'--port',
			'4321',
		]);
		expect(args.indexOf('openai')).toBeGreaterThan(args.indexOf('--instances'));
	});
});

describe('playerCommand', () => {
	it('uses afplay on macOS', () => {
		expect(playerCommand('/t/a.wav', 'darwin')).toEqual({ command: 'afplay', args: ['/t/a.wav'] });
	});

	it('uses a quiet ffplay that exits at the end, elsewhere', () => {
		expect(playerCommand('/t/a.wav', 'linux')).toEqual({
			command: 'ffplay',
			args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '/t/a.wav'],
		});
	});
});

describe('kokoroProblem', () => {
	const folders: string[] = [];
	afterEach(() => {
		for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	/** A home folder and a PATH folder, with the files that the test names. */
	function setup(files: { koko?: boolean; player?: boolean; model?: boolean }) {
		const root = mkdtempSync(join(tmpdir(), 'workbench-kokoro-test-'));
		folders.push(root);
		const bin = join(root, 'bin');
		mkdirSync(bin);
		const config = kokoroConfig({}, root);
		const program = (file: string) => {
			writeFileSync(file, '#!/bin/sh\n');
			chmodSync(file, 0o755);
		};
		if (files.koko) {
			mkdirSync(dirname(config.command), { recursive: true });
			program(config.command);
		}
		if (files.player) program(join(bin, 'ffplay'));
		if (files.model) {
			mkdirSync(join(root, '.cache', 'kokoro'), { recursive: true });
			writeFileSync(config.model, 'm');
			writeFileSync(config.voices, 'v');
		}
		return { config, bin };
	}

	it('is undefined when the program, the model files, and a player are there', async () => {
		const { config, bin } = setup({ koko: true, player: true, model: true });
		expect(await kokoroProblem(config, bin, 'linux')).toBeUndefined();
	});

	it('names each missing part and the fix', async () => {
		const { config, bin } = setup({});
		const note = await kokoroProblem(config, bin, 'linux');
		expect(note).toContain('Spoken replies are off');
		expect(note).toContain(`koko is not installed at ${config.command}`);
		expect(note).toContain('the Kokoro model files are missing');
		expect(note).toContain('ffplay is not installed');
		expect(note).toContain('make voice');
	});

	it('does not look for koko on PATH', async () => {
		const { config, bin } = setup({ player: true, model: true });
		writeFileSync(join(bin, 'koko'), '#!/bin/sh\n');
		chmodSync(join(bin, 'koko'), 0o755);
		expect(await kokoroProblem(config, bin, 'linux')).toContain('koko is not installed');
	});

	it('finds one missing part', async () => {
		const { config, bin } = setup({ koko: true, player: true });
		const note = await kokoroProblem(config, bin, 'linux');
		expect(note).toBe(
			'Spoken replies are off: the Kokoro model files are missing. Run make voice.',
		);
	});
});
