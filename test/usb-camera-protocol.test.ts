import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sensorConformance } from '@ambionframework/workspace/conformance';
import { createSensorClient } from '@ambionframework/workspace/sensors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';

const directory = join(templatesDirectory, 'usb-camera');
const at = '2026-01-01T00:00:00.123Z';
// Freeze only the acquisition clock. Exercise the real server and disk store.
const launch = `
import camera, sys
camera.utc = lambda: '${at}'
source = {'repository': 'instruments/bench-camera', 'commit': 'a' * 40, 'dirty': False}
cam = camera.Camera(source, sys.argv[1], None, demo=True)
cam.acquire()
server = camera.open_server(cam)
print(server.server_port, flush=True)
server.serve_forever()
`;
const python = (() => {
	try {
		execFileSync('python3', ['--version']);
		return true;
	} catch {
		return false;
	}
})();
// The conformance cases need the expected bytes at collection time.
const bytes = python
	? execFileSync(
			'python3',
			['-B', '-c', 'import camera,sys; sys.stdout.buffer.write(camera.demo_png())'],
			{ cwd: directory },
		)
	: Buffer.alloc(0);
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
	: { wav: '', values: [] };
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

describe.skipIf(!python)('the USB camera sensor API v1', () => {
	beforeAll(startServer);
	afterAll(stopServer);

	const cases = sensorConformance(
		{
			name: 'USB camera and microphone',
			open: async () => ({
				request: async (method, path, body) => {
					const response = await fetch(`${root}${path}`, {
						method,
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					});
					const contentType = response.headers.get('content-type');
					return {
						status: response.status,
						contentType,
						...(contentType === 'image/png' || contentType === 'audio/wav'
							? { bytes: new Uint8Array(await response.arrayBuffer()) }
							: { body: await response.json() }),
					};
				},
				dispose: async () => {},
			}),
		},
		{
			span: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' },
			sensors: [
				{
					name: 'camera',
					spans: false,
					withinSpan: [],
					latest: [
						{
							at,
							parts: [
								{ kind: 'text', text: 'SYNTHETIC DEMO: not a bench measurement.' },
								{ kind: 'frame', file: digest, mediaType: 'image/png' },
							],
						},
					],
				},
				{
					name: 'microphone',
					spans: false,
					withinSpan: [],
					latest: [
						{
							at,
							parts: [
								{
									kind: 'text',
									text: 'SYNTHETIC DEMO: not a bench measurement. A 440 Hz tone pulsed at 10 Hz; 1 s clip, 48000 Hz mono 16-bit; peak -6.0 dBFS, RMS -12.0 dBFS.',
								},
								{ kind: 'file', file: wavDigest, name: 'clip.wav', mediaType: 'audio/wav' },
								{
									kind: 'series',
									channel: 'level',
									unit: 'dBFS',
									from: at,
									intervalMs: 10,
									values: clip.values,
								},
							],
						},
					],
				},
			],
			files: [
				{ digest, bytes },
				{ digest: wavDigest, bytes: wavBytes },
			],
		},
	);
	for (const check of cases) it(check.name, check.run);

	it('works with the standard digest-verifying Ambion client', async () => {
		const client = createSensorClient(root);
		expect((await client.index()).source.repository).toBe('instruments/bench-camera');
		expect((await client.observe('camera')).observations[0]?.at).toBe(at);
		expect(Buffer.from((await client.file(digest)).bytes)).toEqual(bytes);
	});

	it('serves the microphone clip through the digest-verifying client', async () => {
		const client = createSensorClient(root);
		expect((await client.index()).sensors.map((sensor) => sensor.name)).toEqual([
			'camera',
			'microphone',
		]);
		const observation = (await client.observe('microphone')).observations[0];
		expect(observation?.parts.map((part) => part.kind)).toEqual(['text', 'file', 'series']);
		expect(Buffer.from((await client.file(wavDigest)).bytes)).toEqual(wavBytes);
	});
});
