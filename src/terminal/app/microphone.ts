import { mkdtempSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Audio, type AudioRecorder } from '@opentui/core';
import type { Take } from '../state/voice.ts';

/** Whisper reads audio at 16 kHz. */
const SAMPLE_RATE = 16_000;

/** The seconds of audio that the capture buffer holds while the file writer catches up. */
const BUFFER_SECONDS = 4;

/** A recording that does not finish in this time is an error. */
const STOP_TIMEOUT_MS = 5_000;

/** What a failed start of the microphone usually needs. */
const ACCESS_HINT =
	'Check that the terminal may use the microphone: System Settings, Privacy & Security, Microphone.';

/** Wait for a recorder to write its file. It fails when the recorder fails or does not finish. */
async function finish(recorder: AudioRecorder, failure: () => Error | undefined): Promise<void> {
	recorder.stop();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<'late'>((resolve) => {
		timer = setTimeout(() => resolve('late'), STOP_TIMEOUT_MS);
	});
	const outcome = await Promise.race([recorder.closed.then(() => 'closed' as const), late]);
	clearTimeout(timer);
	if (outcome === 'late') {
		recorder.dispose();
		throw new Error('The recording did not finish.');
	}
	const error = failure();
	if (error) throw error;
	if (recorder.state !== 'stopped') throw new Error('The recording did not finish.');
}

/**
 * The microphone. It makes the audio engine at the first recording, records
 * mono audio at 16 kHz into a temporary WAV file, and ends the engine and the
 * files in `dispose`.
 */
export class Microphone {
	private audio: Audio | undefined;
	private folder: string | undefined;
	private recorder: AudioRecorder | undefined;
	private count = 0;

	/** Start a recording. */
	async start(): Promise<Take> {
		const audio = this.engine();
		this.count += 1;
		const file = join(this.directory(), `take-${this.count}.wav`);
		const recorder = await audio
			.recordToFile(file, { channels: 1, capacityFrames: SAMPLE_RATE * BUFFER_SECONDS })
			.catch((error: Error) => {
				throw new Error(`${error.message}. ${ACCESS_HINT}`, { cause: error });
			});
		let failure: Error | undefined;
		recorder.on('error', (error) => {
			failure = error;
		});
		this.recorder = recorder;
		return {
			file,
			stop: async () => {
				try {
					await finish(recorder, () => failure);
				} finally {
					if (this.recorder === recorder) this.recorder = undefined;
				}
			},
		};
	}

	/** Delete one WAV file. A file that is already gone is not an error. */
	async discard(file: string): Promise<void> {
		await unlink(file).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT') throw error;
		});
	}

	/** End the open recording, the engine, and the folder of the files. */
	dispose(): void {
		this.recorder?.dispose();
		this.recorder = undefined;
		this.audio?.dispose();
		this.audio = undefined;
		if (this.folder) rmSync(this.folder, { recursive: true, force: true });
		this.folder = undefined;
	}

	private engine(): Audio {
		if (this.audio) return this.audio;
		const audio = Audio.create({ sampleRate: SAMPLE_RATE });
		// An engine error without a listener throws. The recorder reports its own failures.
		audio.on('error', () => {});
		this.audio = audio;
		return audio;
	}

	private directory(): string {
		this.folder ??= mkdtempSync(join(tmpdir(), 'workbench-voice-'));
		return this.folder;
	}
}
