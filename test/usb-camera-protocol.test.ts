import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
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
const bytes = execFileSync(
	'python3',
	['-B', '-c', 'import camera,sys; sys.stdout.buffer.write(camera.demo_png())'],
	{ cwd: directory },
);
const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
let root: string;
let child: ChildProcess;
let data: string;

beforeAll(async () => {
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
});

afterAll(async () => {
	if (child && child.exitCode === null && child.signalCode === null) {
		await new Promise<void>((resolve) => {
			child.once('exit', () => resolve());
			child.kill();
		});
	}
	if (data) await rm(data, { recursive: true, force: true });
});

describe('the USB camera sensor API v1', () => {
	const cases = sensorConformance(
		{
			name: 'USB camera',
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
						...(contentType === 'image/png'
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
			],
			files: [{ digest, bytes }],
		},
	);
	for (const check of cases) it(check.name, check.run);

	it('works with the standard digest-verifying Ambion client', async () => {
		const client = createSensorClient(root);
		expect((await client.index()).source.repository).toBe('instruments/bench-camera');
		expect((await client.observe('camera')).observations[0]?.at).toBe(at);
		expect(Buffer.from((await client.file(digest)).bytes)).toEqual(bytes);
	});
});
