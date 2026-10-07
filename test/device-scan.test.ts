/**
 * The scan of the device-scan template, over fixtures of the macOS tools. A folder of fake
 * `system_profiler`, `ffmpeg`, and `gphoto2` programs prints what those tools print on a Mac,
 * and a fake `serial` package stands for pyserial. The fixtures follow the output of macOS 14
 * and 15, and no Mac ran this test: the field names are an inference. The tier needs python3.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';
import { python } from './python.ts';

const SCAN = join(templatesDirectory, 'device-scan', 'scan', 'scan.py');

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

/** What `system_profiler SPUSBDataType -json` prints: a bus, a hub, and the devices of the bench. */
const PROFILE = {
	SPUSBDataType: [
		{
			_name: 'USB31Bus',
			host_controller: 'AppleT8112USBXHCI',
			_items: [
				{
					_name: 'USB Serial',
					location_id: '0x01100000 / 1',
					product_id: '0x7523',
					vendor_id: '0x1a86',
				},
				{
					_name: 'DP800',
					manufacturer: 'Rigol',
					location_id: '0x01200000 / 2',
					product_id: '0x0e11',
					vendor_id: '0x1ab1  (Rigol Technologies)',
					serial_num: 'DP8A0001',
				},
				{
					_name: 'Logitech BRIO',
					manufacturer: 'Logitech',
					location_id: '0x01300000 / 3',
					product_id: '0x085e',
					vendor_id: '0x046d  (Logitech Inc.)',
				},
				{
					_name: 'USB2.0 Hub',
					location_id: '0x01400000 / 4',
					product_id: '0x0610',
					vendor_id: '0x05e3  (Genesys Logic, Inc.)',
					_items: [
						{
							_name: 'Canon EOS 5D Mark IV',
							location_id: '0x01410000 / 5',
							product_id: '0x32ca',
							vendor_id: '0x04a9  (Canon Inc.)',
						},
						{
							_name: 'Magic Keyboard',
							location_id: '0x01420000 / 6',
							product_id: '0x029c',
							vendor_id: 'apple_vendor_id',
							apple_vendor_id: '0x05ac',
						},
					],
				},
			],
		},
	],
};

/** What `ffmpeg -f avfoundation -list_devices true -i ""` prints on stderr, before it fails. */
const FFMPEG_LIST = `[AVFoundation indev @ 0x6000012a8000] AVFoundation video devices:
[AVFoundation indev @ 0x6000012a8000] [0] FaceTime HD Camera
[AVFoundation indev @ 0x6000012a8000] [1] Logitech BRIO
[AVFoundation indev @ 0x6000012a8000] [2] Capture screen 0
[AVFoundation indev @ 0x6000012a8000] AVFoundation audio devices:
[AVFoundation indev @ 0x6000012a8000] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x6000012a8000] [1] BRIO
[in#0 @ 0x6000012a8100] Error opening input: Input/output error
Error opening input file .
`;

const GPHOTO2 = `Model                          Port
----------------------------------------------------------
Canon EOS 5D Mark IV           usb:001,005
`;

/** A fake pyserial: one USB-serial adapter, and the Bluetooth port that every Mac lists. */
const FAKE_SERIAL = `from types import SimpleNamespace

def comports():
    return [
        SimpleNamespace(device="/dev/cu.usbserial-1410", description="USB Serial", hwid="USB VID:PID=1A86:7523 LOCATION=0-1",
                        vid=0x1A86, pid=0x7523, serial_number=None),
        SimpleNamespace(device="/dev/cu.Bluetooth-Incoming-Port", description="n/a", hwid="n/a",
                        vid=None, pid=None, serial_number=None),
    ]
`;

/** A program that prints a file, and exits with a status. */
async function program(bin: string, name: string, file: string, status = 0, stream = 1) {
	const script = join(bin, name);
	await writeFile(script, `#!/bin/sh\ncat "${file}" >&${stream}\nexit ${status}\n`);
	await chmod(script, 0o755);
}

/** The fake tools in a temporary folder. Returns the folder of the programs and the Python path. */
async function tools(root: string) {
	const bin = join(root, 'bin');
	const lib = join(root, 'lib', 'serial', 'tools');
	await mkdir(bin, { recursive: true });
	await mkdir(lib, { recursive: true });
	await writeFile(join(root, 'usb.json'), JSON.stringify(PROFILE));
	await writeFile(join(root, 'ffmpeg.txt'), FFMPEG_LIST);
	await writeFile(join(root, 'gphoto2.txt'), GPHOTO2);
	await program(bin, 'system_profiler', join(root, 'usb.json'));
	await program(bin, 'ffmpeg', join(root, 'ffmpeg.txt'), 1, 2);
	await program(bin, 'gphoto2', join(root, 'gphoto2.txt'));
	await writeFile(join(root, 'lib', 'serial', '__init__.py'), '');
	await writeFile(join(lib, '__init__.py'), '');
	await writeFile(join(lib, 'list_ports.py'), FAKE_SERIAL);
	return { bin, lib: join(root, 'lib') };
}

async function scan(env: Record<string, string>, out: string) {
	const printed = execFileSync(env.PYTHON ?? 'python3', [SCAN, '--out', out], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
	});
	const [json] = (await readdir(out)).filter((name) => name.endsWith('.json'));
	return { printed, report: JSON.parse(await readFile(join(out, json ?? ''), 'utf8')) };
}

describe.skipIf(!python)('the device scan', () => {
	it('names the kind, the serial port, and the AVFoundation device of each USB device', async () => {
		const root = await mkdtemp(join(tmpdir(), 'workbench-scan-'));
		directories.push(root);
		const { bin, lib } = await tools(root);

		const { printed, report } = await scan(
			{ PATH: `${bin}${delimiter}${process.env.PATH}`, PYTHONPATH: lib },
			join(root, 'scans'),
		);

		const usb = report.usb.map((entry: { id: string; kind: string; nodes: { name: string }[] }) => [
			entry.id,
			entry.kind,
			entry.nodes.map((node) => node.name),
		]);
		expect(usb).toEqual([
			['1a86:7523', 'WCH CH340/CH341 USB-serial', ['/dev/cu.usbserial-1410']],
			['1ab1:0e11', 'instrument (probably USBTMC)', []],
			['046d:085e', 'camera (UVC)', []],
			['05e3:0610', 'hub', []],
			['04a9:32ca', 'camera (PTP, gphoto2)', []],
			['05ac:029c', 'HID', []],
		]);
		const [ch340, rigol, brio] = report.usb;
		expect(rigol).toMatchObject({
			manufacturer: 'Rigol',
			serial: 'DP8A0001',
			port: '0x01200000 / 2',
		});
		expect(ch340.nodes[0].here).toBe(false);
		expect(brio.video).toEqual([{ index: 1, name: 'Logitech BRIO' }]);
		expect(brio.audio).toEqual([{ index: 1, name: 'BRIO' }]);
		expect(report.cameras).toEqual([
			{ index: 0, name: 'FaceTime HD Camera' },
			{ index: 1, name: 'Logitech BRIO' },
			{ index: 2, name: 'Capture screen 0' },
		]);
		expect(report.microphones).toEqual([
			{ index: 0, name: 'MacBook Pro Microphone' },
			{ index: 1, name: 'BRIO' },
		]);
		expect(report.serial).toEqual([
			{
				device: '/dev/cu.Bluetooth-Incoming-Port',
				description: 'n/a',
				hwid: 'n/a',
				usb_id: null,
				serial: null,
			},
			{
				device: '/dev/cu.usbserial-1410',
				description: 'USB Serial',
				hwid: 'USB VID:PID=1A86:7523 LOCATION=0-1',
				usb_id: '1a86:7523',
				serial: null,
			},
		]);
		expect(report.gphoto2).toContain('Canon EOS 5D Mark IV');
		expect(report.errors).toEqual({});
		for (const section of ['## USB', '## Serial ports', '## Cameras', '## Microphones'])
			expect(printed).toContain(section);
		expect(printed).toContain(
			'- **Rigol DP800** `1ab1:0e11` at 0x01200000 / 2: instrument (probably USBTMC)',
		);
		expect(printed).toContain('  - `/dev/cu.usbserial-1410`, not here');
		expect(printed).toContain('  - AVFoundation video 1: Logitech BRIO');
		expect(printed).toContain('- 1: BRIO');
	});

	it('says what is missing when no tool is installed', async () => {
		const root = await mkdtemp(join(tmpdir(), 'workbench-scan-'));
		directories.push(root);
		const empty = join(root, 'empty');
		await mkdir(empty);
		const found = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();

		const { printed, report } = await scan(
			{ PATH: empty, PYTHON: found, PYTHONPATH: '' },
			join(root, 'scans'),
		);

		expect(report.usb).toEqual([]);
		expect(report.cameras).toEqual([]);
		expect(report.errors).toEqual({
			usb: 'system_profiler is not installed',
			avfoundation: 'ffmpeg is not installed',
		});
		expect(report.gphoto2).toBe('gphoto2 is not installed');
		expect(printed).toContain('Problem: system_profiler is not installed.');
		expect(printed).toContain('Problem: ffmpeg is not installed.');
		expect(printed).toContain('No AVFoundation video device.');
	});

	it('falls back to SPUSBHostDataType when SPUSBDataType gives no JSON', async () => {
		const root = await mkdtemp(join(tmpdir(), 'workbench-scan-'));
		directories.push(root);
		const { bin, lib } = await tools(root);
		const host = { SPUSBHostDataType: PROFILE.SPUSBDataType };
		await writeFile(join(root, 'host.json'), JSON.stringify(host));
		await writeFile(
			join(bin, 'system_profiler'),
			`#!/bin/sh\ncase "$1" in SPUSBHostDataType) cat "${join(root, 'host.json')}";; esac\n`,
		);
		await chmod(join(bin, 'system_profiler'), 0o755);

		const { report } = await scan(
			{ PATH: `${bin}${delimiter}${process.env.PATH}`, PYTHONPATH: lib },
			join(root, 'scans'),
		);

		expect(report.usb.map((entry: { id: string }) => entry.id)).toContain('046d:085e');
		expect(report.errors).toEqual({});
	});
});
