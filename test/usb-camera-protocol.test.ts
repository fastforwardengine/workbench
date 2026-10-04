import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';
import { python } from './python.ts';
import {
	expectIndex,
	expectSensor,
	expectUnknown,
	fileOf,
	observationsOf,
	send,
} from './sensor-protocol.ts';

const directory = join(templatesDirectory, 'usb-camera');
const at = '2026-01-01T00:00:00.123Z';
// Freeze only the acquisition clock. Exercise the real server and disk store.
const launch = `
import camera, sys
camera.utc = lambda: '${at}'
source = {'repository': 'engineer/bench-camera', 'commit': 'a' * 40, 'dirty': False}
cam = camera.Camera(source, sys.argv[1], None, demo=True)
cam.acquire()
server = camera.open_server(cam)
print(server.server_port, flush=True)
server.serve_forever()
`;
// The conformance cases need the expected bytes at collection time. Without python3 the suite
// skips, and two different placeholders keep the digests of the fixture apart.
const bytes = python
	? execFileSync(
			'python3',
			['-B', '-c', 'import camera,sys; sys.stdout.buffer.write(camera.demo_png())'],
			{ cwd: directory },
		)
	: Buffer.from('png');
const digest = createHash('sha256').update(bytes).digest('hex');
// The demo clip and the level series of its 10 ms windows.
const clip = python
	? (JSON.parse(
			execFileSync(
				'python3',
				[
					'-B',
					'-c',
					'import base64,camera,json; w=camera.demo_wav(); print(json.dumps({"wav": base64.b64encode(w).decode(), "values": camera.clip_levels(w)[2]}))',
				],
				{ cwd: directory, encoding: 'utf8' },
			),
		) as { wav: string; values: number[] })
	: { wav: Buffer.from('wav').toString('base64'), values: [] };
const wavBytes = Buffer.from(clip.wav, 'base64');
const wavDigest = createHash('sha256').update(wavBytes).digest('hex');
let root: string;
let child: ChildProcess;
let data: string;

async function startServer() {
	data = await mkdtemp(join(tmpdir(), 'workbench-camera-protocol-'));
	child = spawn('python3', ['-u', '-B', '-c', launch, data], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (!child.stdout) throw new Error('Camera fixture has no stdout');
	const stdout = child.stdout;
	root = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Camera fixture readiness timeout')), 5000);
		child.once('error', reject);
		child.once('exit', (code) => reject(new Error(`Camera fixture exited: ${code}`)));
		const lines = createInterface({ input: stdout });
		lines.once('line', (port) => {
			clearTimeout(timer);
			lines.close();
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

async function stopServer() {
	if (child && child.exitCode === null && child.signalCode === null) {
		await new Promise<void>((resolve) => {
			child.once('exit', () => resolve());
			child.kill();
		});
	}
	if (data) await rm(data, { recursive: true, force: true });
}

const SENSORS = [
	{ name: 'camera', spans: false },
	{ name: 'microphone', spans: false },
];

describe.skipIf(!python)('the USB camera sensor protocol, version 2', () => {
	beforeAll(startServer);
	afterAll(stopServer);

	it('lists the camera and the microphone in the index', () =>
		expectIndex(root, 'engineer/bench-camera', SENSORS));

	it.each(SENSORS)('answers the $name sensor to each query', (sensor) =>
		expectSensor(root, sensor),
	);

	it('answers an unknown sensor, path, file, and method with a JSON error', () =>
		expectUnknown(root));

	it('serves the frame that the camera observation names, by its digest', async () => {
		const [observation] = observationsOf(await send(root, '/camera/observe'));
		expect(observation?.at).toBe(at);
		const parts = observation?.parts as { kind: string; file?: string; mediaType?: string }[];
		expect(parts.map((part) => part.kind)).toEqual(['text', 'frame']);
		expect(parts[1]).toMatchObject({ file: digest, mediaType: 'image/png' });
		expect(await fileOf(root, digest)).toEqual(bytes);
	});

	it('serves the microphone clip and its level series', async () => {
		const [observation] = observationsOf(await send(root, '/microphone/observe'));
		const parts = observation?.parts as {
			kind: string;
			file?: string;
			values?: number[];
			intervalMs?: number;
		}[];
		expect(parts.map((part) => part.kind)).toEqual(['text', 'file', 'series']);
		expect(parts[1]?.file).toBe(wavDigest);
		expect(parts[2]?.values).toEqual(clip.values);
		expect(parts[2]?.intervalMs).toBe(10);
		expect(await fileOf(root, wavDigest)).toEqual(wavBytes);
	});
});
