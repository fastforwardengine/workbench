/**
 * psu.py of the hm310p template, on its simulated supply: a 100 ohm load,
 * with the state in a file. The tier needs python3, and no hardware.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/** The limits of a supply: the template's limits.json unless a test names others. */
interface Limits {
	max_voltage: number;
	max_current: number;
	max_power: number;
}

/**
 * A command on one simulated supply: the exit status, the JSON it printed,
 * and its error. `writes` gives each register write so far, in order.
 */
async function supply(limits?: Limits) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-psu-'));
	directories.push(directory);
	const state = join(directory, 'sim.json');
	const options: string[] = [];
	if (limits) {
		const path = join(directory, 'limits.json');
		await writeFile(path, JSON.stringify(limits));
		options.push('--limits', path);
	}
	const run = (...args: string[]) => {
		const done = spawnSync('python3', [PSU, ...options, '--sim', state, ...args, '--json'], {
			encoding: 'utf8',
		});
		return {
			status: done.status,
			json: done.stdout ? JSON.parse(done.stdout) : undefined,
			error: done.stderr.trim(),
		};
	};
	const writes = async (): Promise<number[][]> => JSON.parse(await readFile(state, 'utf8')).writes;
	return Object.assign(run, { writes });
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
		expect(refusals[0]?.error).toBe(
			'psu: The setpoints: the voltage 6 V is above the limit 5 V of limits.json.',
		);
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
		const psu = await supply({ max_voltage: 30, max_current: 10, max_power: 300 });
		expect(psu('protect').json).toEqual({ ovp: 33, ocp: 10.5, opp: 310 });
		expect(psu('protect', '--ovp', '5', '--ocp', '0.5', '--opp', '72.5').json).toEqual({
			ovp: 5,
			ocp: 0.5,
			opp: 72.5,
		});
		// 72.5 W is 72500 in thousandths: one in the high word, 6964 in the low word.
		expect(psu('read', '0x0022', '2').json).toEqual({ '0x0022': 1, '0x0023': 6964 });
		// OVP above the rating of 33 V.
		expect(psu('protect', '--ovp', '40').status).toBe(1);
	});

	it('refuses a protection limit above limits.json, and writes none of a refused set', async () => {
		const psu = await supply();
		for (const args of [
			['--ovp', '6'],
			['--ocp', '0.6'],
			['--opp', '3'],
			['--ovp', '4', '--opp', '3'],
		]) {
			const refused = psu('protect', ...args);
			expect(refused.status, args.join(' ')).toBe(1);
			expect(refused.error).toMatch(/of limits.json\.$/);
		}
		// The last refusal holds a valid OVP: it is not written either.
		expect(psu('protect').json).toEqual({ ovp: 33, ocp: 10.5, opp: 310 });
		expect(psu('protect', '--ovp', '5', '--ocp', '0.5', '--opp', '2.5').json).toEqual({
			ovp: 5,
			ocp: 0.5,
			opp: 2.5,
		});
	});

	it('writes the current first when the voltage rises, so no state between exceeds the power limit', async () => {
		const psu = await supply({ max_voltage: 5, max_current: 0.5, max_power: 1 });
		psu('set', '--voltage', '1', '--current', '0.5');
		const before = (await psu.writes()).length;
		// From 1 V at 0.5 A to 5 V at 0.1 A: voltage first would hold 5 V at 0.5 A, 2.5 W.
		expect(psu('set', '--voltage', '5', '--current', '0.1').json).toEqual({
			voltage: 5,
			current: 0.1,
		});
		expect((await psu.writes()).slice(before)).toEqual([
			[0x31, 100],
			[0x30, 500],
		]);
		// When the voltage falls, the voltage goes first.
		const after = (await psu.writes()).length;
		psu('set', '--voltage', '2', '--current', '0.4');
		expect((await psu.writes()).slice(after)).toEqual([
			[0x30, 200],
			[0x31, 400],
		]);
	});

	it('checks the whole preset, with the stored value it keeps', async () => {
		const psu = await supply();
		// Preset 1 holds 1.010 A, above the limit of 0.5 A, so a new voltage alone is refused.
		const refused = psu('preset', 'set', '1', '--voltage', '4');
		expect(refused.status).toBe(1);
		expect(refused.error).toBe(
			'psu: Preset 1: the current 1.01 A is above the limit 0.5 A of limits.json.',
		);
		expect(psu('preset', 'set', '1', '--voltage', '4', '--current', '0.5').status).toBe(0);
		// 4.9 V at 0.5 A is 2.45 W, within 2.5 W. 5 V at 0.5 A is 2.5 W, the limit itself.
		expect(psu('preset', 'set', '1', '--voltage', '5').status).toBe(0);
		const limited = await supply({ max_voltage: 5, max_current: 0.5, max_power: 1 });
		limited('preset', 'set', '2', '--voltage', '1', '--current', '0.1');
		expect(limited('preset', 'set', '2', '--voltage', '5', '--current', '0.5').error).toMatch(
			/Preset 2: the power 2\.5 W is above the limit 1 W/,
		);
	});

	it('reports a serial port that fails in one line, with no traceback', () => {
		const done = spawnSync('python3', [PSU, '--port', '/dev/workbench-no-such-port', 'status'], {
			encoding: 'utf8',
		});
		expect(done.status).toBe(1);
		// Without pyserial, the tool says so. With it, the port fails to open.
		expect(done.stderr.trim()).toMatch(
			/^psu: (pyserial is not installed|The serial port \/dev\/workbench-no-such-port failed)/,
		);
		expect(done.stderr).not.toContain('Traceback');
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
