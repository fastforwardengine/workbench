import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sensorConformance } from '@ambionframework/workspace/conformance';
import { createSensorClient } from '@ambionframework/workspace/sensors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';

const directory = join(templatesDirectory, 'psu');
const T0 = Date.UTC(2026, 0, 1);
const iso = (offset: number) => new Date(T0 + offset).toISOString();

// The scenario runs on the simulator with a fixed set of slots: 20 slots of
// 250 ms with a gap at slots 8 and 9, and a voltage change before slot 12.
// The mode `serve` serves it. The mode `recent` prints the bytes of the recent
// document. The mode `text` prints the text part of the recent observation.
const launch = `
import datetime, json, os, sys
mode, base = sys.argv[1:3]
os.environ['PSU_LOCK_DIR'] = base + '/locks'
import sensor
from drivers.sim import Sim
from guard import Guard
T0 = int(datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000)
channels = {
    'ch1': {'label': 'radio', 'max_voltage': 5.0, 'max_current': 0.5, 'max_power': 2.5},
    'ch2': {'label': 'led', 'max_voltage': 3.0, 'max_current': 0.05, 'max_power': 0.15},
}
config = {'name': 'psu', 'driver': 'sim', 'channels': channels}
guard = Guard(Sim(base + '/sim.json', list(channels)), config, actuator='sensor.py')
source = {'repository': 'instruments/bench-psu', 'commit': 'a' * 40, 'dirty': False}
probe = sensor.Sensor(guard, config, base + '/data', source, clock=lambda: T0 + 4750)
guard.set('ch1', 5.0, 0.5)
guard.output('ch1', True)
for k in range(20):
    if k == 12:
        guard.set('ch1', voltage=4.0)
    if k not in (8, 9):
        probe.sample(T0 + 250 * k)
    if k in (0, 4, 12, 16):
        probe.observe_settings(T0 + 250 * k)
if mode == 'recent':
    sys.stdout.buffer.write(probe.recent_bytes())
elif mode == 'text':
    sys.stdout.write(probe.recent_latest()[0]['parts'][0]['text'])
else:
    server = sensor.open_server(probe)
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

/** Run the scenario once in a mode that prints, with its own temporary directory. */
function collect(mode: 'recent' | 'text'): Buffer {
	if (!python) return Buffer.alloc(0);
	const base = mkdtempSync(join(tmpdir(), 'workbench-psu-collect-'));
	try {
		return execFileSync('python3', ['-B', '-c', launch, mode, base], { cwd: directory });
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

// The conformance cases need the expected bytes at collection time.
const bytes = collect('recent');
const recentText = collect('text').toString('utf8');
const digest = createHash('sha256').update(bytes).digest('hex');
let root: string;
let child: ChildProcess;
let data: string;

async function startServer() {
	data = await mkdtemp(join(tmpdir(), 'workbench-psu-protocol-'));
	child = spawn('python3', ['-u', '-B', '-c', launch, 'serve', data], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (!child.stdout) throw new Error('PSU fixture has no stdout');
	const stdout = child.stdout;
	root = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('PSU fixture readiness timeout')), 10000);
		child.once('error', reject);
		child.once('exit', (code) => reject(new Error(`PSU fixture exited: ${code}`)));
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

/** The three series parts of one channel. */
function series(channel: string, from: number, values: [number[], number[], number[]]) {
	const quantities: [string, string][] = [
		['voltage', 'V'],
		['current', 'A'],
		['power', 'W'],
	];
	return quantities.map(([quantity, unit], index) => ({
		kind: 'series' as const,
		channel: `${channel}/${quantity}`,
		unit,
		from: iso(from),
		intervalMs: 250,
		values: values[index] ?? [],
	}));
}

/** One run of samples: ch1 follows the given values, ch2 is off. */
function run(from: number, volts: number[], amps: number[], watts: number[]) {
	const zeros = volts.map(() => 0);
	return {
		at: iso(from + 250 * (volts.length - 1)),
		parts: [
			...series('ch1', from, [volts, amps, watts]),
			...series('ch2', from, [zeros, zeros, zeros]),
		],
	};
}

const run1 = run(0, Array(8).fill(5), Array(8).fill(0.05), Array(8).fill(0.25));
const run2 = run(
	2500,
	[5, 5, 4, 4, 4, 4, 4, 4, 4, 4],
	[0.05, 0.05, ...Array(8).fill(0.04)],
	[0.25, 0.25, ...Array(8).fill(0.16)],
);
// The span T0+1000 .. T0+3000 holds slots 4 to 7 of run 1 and slots 10 and 11 of run 2.
const spanRun1 = run(1000, Array(4).fill(5), Array(4).fill(0.05), Array(4).fill(0.25));
const spanRun2 = run(2500, [5, 5], [0.05, 0.05], [0.25, 0.25]);

const settingsText = [
	'Supply psu, Simulated supply, 2 channels, snapshot at 2026-01-01T00:00:04.000Z.',
	'ch1 (radio): output on, CV. Setpoints 4.000 V, 0.500 A. OVP 33.000 V, OCP 10.500 A. Tripped: none. Driven by: nobody.',
	'ch2 (led): output off. Setpoints 0.000 V, 0.000 A. OVP 33.000 V, OCP 10.500 A. Tripped: none. Driven by: nobody.',
].join('\n');

describe.skipIf(!python)('the psu sensor API v1', () => {
	beforeAll(startServer);
	afterAll(stopServer);

	const cases = sensorConformance(
		{
			name: 'PSU',
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
						...(path.startsWith('/files/') && response.status === 200
							? { bytes: new Uint8Array(await response.arrayBuffer()) }
							: { body: await response.json() }),
					};
				},
				dispose: async () => {},
			}),
		},
		{
			span: { from: iso(1000), to: iso(3000) },
			sensors: [
				{ name: 'output', spans: true, withinSpan: [spanRun1, spanRun2], latest: [run1, run2] },
				{
					name: 'recent',
					spans: false,
					withinSpan: [],
					latest: [
						{
							at: iso(4750),
							parts: [
								{ kind: 'text', text: recentText },
								{ kind: 'file', file: digest, name: 'recent.json', mediaType: 'application/json' },
							],
						},
					],
				},
				{
					name: 'settings',
					spans: false,
					withinSpan: [],
					latest: [{ at: iso(4000), parts: [{ kind: 'text', text: settingsText }] }],
				},
			],
			files: [{ digest, bytes }],
		},
	);
	for (const check of cases) it(check.name, check.run);

	it('states the recent windows of ch1 voltage', () => {
		const document = JSON.parse(bytes.toString('utf8'));
		expect(document.at).toBe(iso(4750));
		expect(document.period_ms).toBe(250);
		expect(document.error).toBeNull();
		const windows = document.channels.ch1.voltage.windows;
		expect(windows['3']).toEqual({
			n: 10,
			expected: 12,
			min: 4,
			p5: 4,
			p25: 4,
			p50: 4,
			p75: 4,
			p95: 5,
			max: 5,
			mean: 4.2,
		});
		expect(windows['5'].n).toBe(18);
		expect(windows['5'].expected).toBe(20);
		expect(document.changes).toEqual([
			{
				at: iso(3000),
				age_seconds: 1.75,
				channel: 'ch1',
				key: 'voltage',
				from: 5,
				to: 4,
				owner: null,
			},
		]);
	});

	it('writes the recent text for a reader', () => {
		const lines = recentText.split('\n');
		expect(lines[0]).toBe('Supply psu, latest sample 2026-01-01T00:00:04.750Z, period 250 ms.');
		expect(lines).toContain('ch1 (radio)');
		expect(lines).toContain('ch2 (led)');
		expect(lines.some((line) => /^voltage V\s+3 s\s+10\/12\s+4\.000/.test(line))).toBe(true);
		expect(lines).toContain('Changes in the last 60 s:');
		expect(lines).toContain('1.75 s ago, ch1 voltage: 5.000 to 4.000. Driven by: nobody.');
	});

	it('works with the standard digest-verifying Ambion client', async () => {
		const client = createSensorClient(root);
		expect((await client.index()).source.repository).toBe('instruments/bench-psu');
		expect((await client.observe('output')).observations).toEqual([run1, run2]);
		expect(Buffer.from((await client.file(digest)).bytes)).toEqual(bytes);
	});
});
