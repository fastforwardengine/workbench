import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** The program of whisper.cpp that keeps the model loaded and answers over HTTP. */
const WHISPER_COMMAND = 'whisper-server';

/** Where the model is when `WORKBENCH_WHISPER_MODEL` is not set. */
const DEFAULT_MODEL = join('.cache', 'whisper', 'ggml-large-v3.bin');

/** Where the person gets the default model. */
export const MODEL_URL =
	'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';

/** How the terminal runs whisper-server. */
export interface WhisperConfig {
	command: string;
	/** The path of the model file. */
	model: string;
	/** True when `WORKBENCH_WHISPER_MODEL` names the model. */
	custom: boolean;
}

/** Read the settings. `WORKBENCH_WHISPER_MODEL` names another model file, and a leading `~/` means the home folder. */
export function whisperConfig(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): WhisperConfig {
	const named = env.WORKBENCH_WHISPER_MODEL?.trim();
	const model = named ? named.replace(/^~(?=\/|$)/, home) : join(home, DEFAULT_MODEL);
	return { command: WHISPER_COMMAND, model, custom: Boolean(named) };
}

/** The address that the server listens on. Only this computer reaches it. */
export const SERVER_HOST = '127.0.0.1';

/**
 * The arguments of whisper-server: the model, the address, no timestamps, any
 * language, and a beam search of width 5 for the best words.
 */
export function serverArgs(config: WhisperConfig, port: number): string[] {
	return [
		'-m',
		config.model,
		'--host',
		SERVER_HOST,
		'--port',
		String(port),
		'-nt',
		'-l',
		'auto',
		'-bs',
		'5',
	];
}

const exists = (path: string): Promise<boolean> =>
	access(path, constants.R_OK).then(
		() => true,
		() => false,
	);

/** True when a program of that name runs from a folder in PATH. */
async function onPath(command: string, path: string | undefined): Promise<boolean> {
	for (const folder of (path ?? '').split(delimiter)) {
		if (folder === '') continue;
		const found = await access(join(folder, command), constants.X_OK).then(
			() => true,
			() => false,
		);
		if (found) return true;
	}
	return false;
}

/**
 * What stops voice mode from starting, with the exact fix, or undefined when
 * whisper-server and the model are there. One message names every fix.
 */
export async function whisperProblem(
	config: WhisperConfig,
	path: string | undefined = process.env.PATH,
): Promise<string | undefined> {
	const fixes: string[] = [];
	if (!(await onPath(config.command, path)))
		fixes.push('Install whisper.cpp: brew install whisper-cpp');
	if (!(await exists(config.model))) {
		fixes.push(
			config.custom
				? `WORKBENCH_WHISPER_MODEL names a file that does not exist: ${config.model}`
				: `Download the model: mkdir -p ${dirname(config.model)} && curl -L -o ${config.model} ${MODEL_URL}`,
		);
	}
	if (fixes.length === 0) return undefined;
	const once = config.custom ? [] : ['In the Workbench folder, `make voice` does all of it.'];
	return ['Voice mode stays off.', ...fixes, ...once].join('\n');
}
