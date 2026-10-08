import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playerCommand } from './kokoro.ts';

/** Run a player to its end. An abort kills it and counts as a normal end. */
function play(command: string, args: string[], signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'ignore' });
		const stop = () => child.kill('SIGKILL');
		signal.addEventListener('abort', stop, { once: true });
		const done = () => signal.removeEventListener('abort', stop);
		child.once('error', (error) => {
			done();
			reject(new Error(`${command} failed: ${error.message}`));
		});
		child.once('close', (code) => {
			done();
			if (code === 0 || signal.aborted) resolve();
			else reject(new Error(`${command} ended with code ${code}`));
		});
	});
}

/**
 * Play a WAV file. The file goes to a temporary folder, and the folder goes
 * away when the player ends. An aborted signal kills the player.
 */
export async function playWav(wav: Uint8Array, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	const folder = await mkdtemp(join(tmpdir(), 'workbench-speech-'));
	try {
		const file = join(folder, 'reply.wav');
		await writeFile(file, wav);
		if (signal.aborted) return;
		const { command, args } = playerCommand(file);
		await play(command, args, signal);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}
