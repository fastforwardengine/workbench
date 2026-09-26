/**
 * The scan of the device-scan template, over a fake sysfs folder, so it runs
 * with no hardware. The folder holds a CH340 USB-serial adapter, a USBTMC
 * instrument, a UVC camera, and a root hub. The tier needs python3.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';

const SCAN = join(templatesDirectory, 'device-scan', 'scan', 'scan.py');

const python = (() => {
	try {
		execFileSync('python3', ['--version']);
		return true;
	} catch {
		return false;
	}
})();

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

/** One USB device in the fake sysfs folder, with one interface. */
async function device(
	root: string,
	port: string,
	files: Record<string, string>,
	interfaceFiles: Record<string, string>,
	node?: string,
) {
	const dir = join(root, port);
	await mkdir(dir, { recursive: true });
	for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), `${value}\n`);
	const iface = join(dir, `${port}:1.0`);
	await mkdir(iface, { recursive: true });
	for (const [name, value] of Object.entries(interfaceFiles))
		await writeFile(join(iface, name), `${value}\n`);
	if (node) await mkdir(join(iface, node), { recursive: true });
}

describe.skipIf(!python)('the device scan', () => {
	it('names the kind and the device file of each USB device, and leaves out the root hub', async () => {
		const root = await mkdtemp(join(tmpdir(), 'workbench-sysfs-'));
		directories.push(root);
		const sysfs = join(root, 'sysfs');
		const out = join(root, 'scans');
		const iface = (klass: string, sub = '00') => ({
			bInterfaceClass: klass,
			bInterfaceSubClass: sub,
			bInterfaceProtocol: '00',
		});
		await device(sysfs, 'usb1', { idVendor: '1d6b', idProduct: '0002' }, iface('09'));
		await device(
			sysfs,
			'1-1',
			{ idVendor: '1a86', idProduct: '7523', product: 'USB Serial', busnum: '1', devnum: '2' },
			iface('ff'),
			'ttyUSB0',
		);
		await device(
			sysfs,
			'1-2',
			{
				idVendor: '1ab1',
				idProduct: '0e11',
				manufacturer: 'Rigol',
				product: 'DP800',
				busnum: '1',
				devnum: '3',
			},
			iface('fe', '03'),
			'usbmisc/usbtmc0',
		);
		await device(
			sysfs,
			'1-3',
			{ idVendor: '046d', idProduct: '0825', product: 'Webcam C270', busnum: '1', devnum: '4' },
			iface('0e', '01'),
			'video4linux/video0',
		);

		const printed = execFileSync('python3', [SCAN, '--out', out], {
			encoding: 'utf8',
			env: { ...process.env, DEVICE_SCAN_SYSFS_USB: sysfs },
		});
		const [json] = (await readdir(out)).filter((name) => name.endsWith('.json'));
		const report = JSON.parse(await readFile(join(out, json ?? ''), 'utf8'));
		const usb = report.usb.map((entry: { id: string; kind: string; nodes: { name: string }[] }) => [
			entry.id,
			entry.kind,
			entry.nodes.map((node) => node.name),
		]);
		expect(usb).toEqual([
			['1a86:7523', 'WCH CH340/CH341 USB-serial', ['/dev/ttyUSB0']],
			['1ab1:0e11', 'instrument (USBTMC)', ['/dev/usbtmc0']],
			['046d:0825', 'camera (UVC)', ['/dev/video0']],
		]);
		// The files are not in this container, so the report says where to add them.
		expect(printed).toContain('**Rigol DP800** `1ab1:0e11` at port 1-2: instrument (USBTMC)');
		expect(printed).toContain('`/dev/usbtmc0`, not in the container yet: scan again in 5 seconds');
	});
});
