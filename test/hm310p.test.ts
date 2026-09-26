/**
 * psu.py of the hm310p template, on its simulated supply: a 100 ohm load,
 * with the state in a file. The tier needs python3, and no hardware.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';

const PSU = join(templatesDirectory, 'hm310p', 'psu.py');

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

/** A command on one simulated supply: the exit status, the JSON it printed, and its error. */
async function supply() {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-psu-'));
	directories.push(directory);
	const state = join(directory, 'sim.json');
	return (...args: string[]) => {
		const done = spawnSync('python3', [PSU, '--sim', state, ...args, '--json'], {
			encoding: 'utf8',
		});
		return {
			status: done.status,
			json: done.stdout ? JSON.parse(done.stdout) : undefined,
			error: done.stderr.trim(),
		};
	};
}

describe.skipIf(!python)('the hm310p tool on a simulated supply', () => {
	it('identifies the supply, and starts with the output off', async () => {
		const psu = await supply();
		expect(psu('info').json).toEqual({
			model: 3010,
			tail: 19280,
			decimals: '0x0233',
			address: 1,
		});
		expect(psu('status').json).toMatchObject({ output: 'off', tripped: [] });
	});

	it('sets the output within limits.json, and refuses each value above it', async () => {
		const psu = await supply();
		expect(psu('set', '--voltage', '3.3', '--current', '0.02').json).toEqual({
			voltage: 3.3,
			current: 0.02,
		});
		const refusals = [
			psu('set', '--voltage', '6'),
			psu('set', '--current', '0.8'),
			psu('set', '--voltage', '-1'),
			psu('preset', 'set', '1', '--current', '1'),
		];
		for (const refused of refusals) expect(refused.status).toBe(1);
		expect(refusals[0]?.error).toBe('psu: The voltage 6 V is above the limit 5 V of limits.json.');
		// A refused command changes nothing.
		expect(psu('status').json.setpoints).toEqual({ voltage: 3.3, current: 0.02 });
	});

	it('limits the current on the load, and reads the output while it is on', async () => {
		const psu = await supply();
		psu('set', '--voltage', '1.0', '--current', '0.5');
		expect(psu('output', 'on').json).toEqual({ output: 'on' });
		// 1 V on 100 ohm: constant voltage, 10 mA.
		expect(psu('measure').json).toMatchObject({ voltage: 1, current: 0.01, power: 0.01 });
		psu('set', '--voltage', '3.3', '--current', '0.02');
		// 3.3 V wants 33 mA: the 20 mA limit holds, so the voltage falls to 2 V.
		expect(psu('measure').json).toMatchObject({ voltage: 2, current: 0.02, power: 0.04 });
		expect(psu('output', 'off').json).toEqual({ output: 'off' });
		expect(psu('measure').json).toMatchObject({ voltage: 0, current: 0, power: 0 });
	});

	it('sets the protection limits, with OPP across two registers', async () => {
		const psu = await supply();
		expect(psu('protect').json).toEqual({ ovp: 33, ocp: 10.5, opp: 310 });
		expect(psu('protect', '--ovp', '5', '--ocp', '0.5', '--opp', '72.5').json).toEqual({
			ovp: 5,
			ocp: 0.5,
			opp: 72.5,
		});
		// 72.5 W is 72500 in thousandths: one in the high word, 6964 in the low word.
		expect(psu('read', '0x0022', '2').json).toEqual({ '0x0022': 1, '0x0023': 6964 });
		expect(psu('protect', '--ovp', '40').status).toBe(1);
	});

	it('shows the six presets, sets one, and guards a change of address', async () => {
		const psu = await supply();
		expect(psu('preset', 'show').json).toHaveLength(6);
		expect(psu('preset', 'set', '2', '--voltage', '3.3', '--current', '0.1').json).toEqual({
			preset: 2,
			voltage: 3.3,
			current: 0.1,
			time: 11,
			enabled: 1,
		});
		expect(psu('address', '5').error).toMatch(/Add --yes/);
		expect(psu('address').json).toEqual({ address: 1 });
		expect(psu('buzzer', 'on').json).toEqual({ buzzer: 'on' });
	});
});
