/**
 * The plan of workstation/usb.py: which USB device `make usb` attaches,
 * attaches again, detaches, or leaves. The plan is a pure function of the
 * devices, their OrbStack machines, and what Linux sees, so it runs with no
 * OrbStack. The tier needs python3.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const USB = fileURLToPath(new URL('../workstation/usb.py', import.meta.url));

const python = (() => {
	try {
		execFileSync('python3', ['--version']);
		return true;
	} catch {
		return false;
	}
})();

interface Device {
	bus_id: string;
	vendor_id: number;
	product_id: number;
	path: string;
	category: string;
}

const device = (bus_id: string, id: string, path: string, category = 'serial'): Device => {
	const [vendor, product] = id.split(':');
	return {
		bus_id,
		vendor_id: Number.parseInt(vendor ?? '0', 16),
		product_id: Number.parseInt(product ?? '0', 16),
		path,
		category,
	};
};

/** The steps of the plan: [bus_id, step, note] for each device. */
function plan(
	action: 'attach' | 'detach',
	devices: Device[],
	machines: Record<string, string | null>,
	seen: Record<string, number> | null,
	skip: string[] = [],
): [string, string, string][] {
	const script = `
import importlib.util, json, sys
from collections import Counter
spec = importlib.util.spec_from_file_location("usb", sys.argv[1])
usb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usb)
action, devices, machines, seen, skip = json.loads(sys.argv[2])
steps = usb.plan(action, devices, machines, None if seen is None else Counter(seen), set(skip))
print(json.dumps([[bus_id, step, note] for bus_id, _, step, note in steps]))
`;
	const input = JSON.stringify([action, devices, machines, seen, skip]);
	return JSON.parse(execFileSync('python3', ['-c', script, USB, input], { encoding: 'utf8' }));
}

const keyboard = device('k', '05ac:024f', 'Keychron K3', 'input');
const billboard = device('b', '2109:8888', 'USB Billboard Device', 'billboard');
const camera = device('c', '046d:085e', 'Logitech BRIO', 'video');
const supply = device('s1', '1a86:7523', 'USB2.0-Serial');
const twin = device('s2', '1a86:7523', 'USB2.0-Serial');

describe.skipIf(!python)('the USB plan of the workstation', () => {
	it('keeps input devices, billboards, and ignored IDs with macOS', () => {
		const steps = plan('attach', [keyboard, billboard, camera], {}, {}, ['046d:085e']);
		expect(steps.map(([bus, step]) => [bus, step])).toEqual([
			['k', 'keep'],
			['b', 'keep'],
			['c', 'keep'],
		]);
	});

	it('attaches a device with macOS, and leaves one that Linux sees', () => {
		const steps = plan('attach', [camera, supply], { c: null, s1: 'default' }, { '1a86:7523': 1 });
		expect(steps.map(([bus, step]) => [bus, step])).toEqual([
			['c', 'attach'],
			['s1', 'done'],
		]);
	});

	it('attaches again a device that OrbStack holds for the workstation and Linux lost', () => {
		const steps = plan('attach', [camera, supply], { c: 'default', s1: 'default' }, {});
		expect(steps.map(([bus, step]) => [bus, step])).toEqual([
			['c', 'reattach'],
			['s1', 'reattach'],
		]);
	});

	it('leaves a device that another OrbStack machine holds, also when Linux does not see it', () => {
		const steps = plan('attach', [supply], { s1: 'ubuntu' }, {});
		expect(steps).toEqual([['s1', 'elsewhere', 'ubuntu']]);
	});

	it('finds a lost device by the count of its ID, when a twin still shows', () => {
		const steps = plan(
			'attach',
			[supply, twin],
			{ s1: 'default', s2: 'default' },
			{
				'1a86:7523': 1,
			},
		);
		expect(steps.map(([bus, step]) => [bus, step])).toEqual([
			['s1', 'reattach'],
			['s2', 'reattach'],
		]);
		const whole = plan(
			'attach',
			[supply, twin],
			{ s1: 'default', s2: 'default' },
			{
				'1a86:7523': 2,
			},
		);
		expect(whole.map(([, step]) => step)).toEqual(['done', 'done']);
	});

	it('attaches nothing again when the container does not run', () => {
		const steps = plan('attach', [supply], { s1: 'default' }, null);
		expect(steps.map(([bus, step]) => [bus, step])).toEqual([['s1', 'done']]);
	});

	it('detaches only the devices of the workstation', () => {
		const steps = plan(
			'detach',
			[keyboard, camera, supply, twin],
			{ c: 'default', s1: 'ubuntu', s2: null },
			null,
		);
		expect(steps.map(([bus, step]) => [bus, step])).toEqual([
			['k', 'keep'],
			['c', 'detach'],
			['s1', 'elsewhere'],
			['s2', 'done'],
		]);
	});
});
