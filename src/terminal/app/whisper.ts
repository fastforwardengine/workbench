import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { cleanTranscript } from '../state/voice.ts';

/** The program of whisper.cpp that reads a WAV file. */
const WHISPER_COMMAND = 'whisper-cli';

/** Where the model is when `WORKBENCH_WHISPER_MODEL` is not set. */
const DEFAULT_MODEL = join('.cache', 'whisper', 'ggml-large-v3.bin');

/** Where the person gets the default model. */
export const MODEL_URL =
	'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';

/** A transcription that runs longer than this stops. */
const WHISPER_TIMEOUT_MS = 120_000;

/** The most output of whisper-cli that the terminal keeps. */
const MAX_OUTPUT_BYTES = 1_000_000;

/** How the terminal runs whisper-cli. */
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

/**
 * The arguments of whisper-cli: no timestamps, no progress text, any language,
 * and a beam search of width 5 for the best words.
 */
export function whisperArgs(config: WhisperConfig, file: string): string[] {
	return ['-m', config.model, '-f', file, '-nt', '-np', '-l', 'auto', '-bs', '5', '-bo', '5'];
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
 * whisper-cli and the model are there. One message names every fix.
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
	return ['Voice mode stays off.', ...fixes].join('\n');
}

/** The last line that whisper-cli wrote to stderr, or the error message. */
function failureLine(error: Error & { killed?: boolean }, stderr: string): string {
	if (error.killed) return `it ran longer than ${WHISPER_TIMEOUT_MS / 1000} s`;
	const lines = stderr.split('\n').filter((line) => line.trim() !== '');
	return (lines.at(-1) ?? error.message.split('\n')[0] ?? 'it failed').trim().slice(0, 200);
}

/**
 * Read the speech in a WAV file with whisper-cli, and return the words. The
 * signal stops the process. A failure is one line of text.
 */
export function transcribe(
	config: WhisperConfig,
	file: string,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			config.command,
			whisperArgs(config, file),
			{ signal, timeout: WHISPER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
			(error, stdout, stderr) => {
				if (!error) return resolve(cleanTranscript(stdout));
				if (error.name === 'AbortError') return reject(error);
				reject(
					new Error(`${basename(config.command)} failed: ${failureLine(error, String(stderr))}`),
				);
			},
		);
	});
}
