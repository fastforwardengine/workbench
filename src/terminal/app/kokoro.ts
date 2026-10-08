import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exists, onPath, SERVER_HOST } from './whisper.ts';

/** Where `make voice` puts `koko` and the model files, below the home folder. */
const MODEL_FOLDER = join('.cache', 'kokoro');

/** The voice of the replies, when `WORKBENCH_KOKORO_VOICE` is not set. */
const DEFAULT_VOICE = 'af_heart';

/** How the terminal runs `koko`. */
export interface KokoroConfig {
	/** The path of `koko`, the program of Kokoros that keeps the Kokoro model loaded and answers over HTTP. */
	command: string;
	/** The path of the ONNX model file. */
	model: string;
	/** The path of the file that holds the voices. */
	voices: string;
	/** The name of the voice, such as `af_heart`. */
	voice: string;
}

/**
 * Read the settings. `koko` is `~/.cache/kokoro/bin/koko`, and the model
 * files are in `~/.cache/kokoro/`. `make voice` puts them there. The settings
 * do not use PATH. `WORKBENCH_KOKORO_VOICE` names another voice of the voices
 * file.
 */
export function kokoroConfig(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): KokoroConfig {
	return {
		command: join(home, MODEL_FOLDER, 'bin', 'koko'),
		model: join(home, MODEL_FOLDER, 'kokoro-v1.0.onnx'),
		voices: join(home, MODEL_FOLDER, 'voices-v1.0.bin'),
		voice: env.WORKBENCH_KOKORO_VOICE?.trim() || DEFAULT_VOICE,
	};
}

/**
 * The arguments of `koko` in server mode. The global arguments come before
 * the subcommand. One instance gives the lowest latency, and a mono file
 * suits a speaker.
 */
export function kokoroArgs(config: KokoroConfig, port: number): string[] {
	return [
		'-m',
		config.model,
		'-d',
		config.voices,
		'-s',
		config.voice,
		'--mono',
		'--instances',
		'1',
		'openai',
		'--ip',
		SERVER_HOST,
		'--port',
		String(port),
	];
}

/** The program and the arguments that play a WAV file. macOS has `afplay`. Other systems use `ffplay`, which comes with ffmpeg. */
export function playerCommand(
	file: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === 'darwin') return { command: 'afplay', args: [file] };
	return { command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] };
}

/** True when the file exists and the user can run it. */
const runs = (file: string): Promise<boolean> =>
	access(file, constants.X_OK).then(
		() => true,
		() => false,
	);

/**
 * What stops spoken replies, as one note, or undefined when `koko`, the model
 * files, and a player are there. `path` is the PATH that finds the player. The note names each missing part.
 */
export async function kokoroProblem(
	config: KokoroConfig,
	path: string | undefined = process.env.PATH,
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	const missing: string[] = [];
	if (!(await runs(config.command))) missing.push(`koko is not installed at ${config.command}`);
	if (!(await exists(config.model)) || !(await exists(config.voices)))
		missing.push('the Kokoro model files are missing');
	const player = playerCommand('', platform).command;
	if (!(await onPath(player, path))) missing.push(`${player} is not installed`);
	if (missing.length === 0) return undefined;
	return `Spoken replies are off: ${missing.join(', ')}. Run make voice.`;
}
