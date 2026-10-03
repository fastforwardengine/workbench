/**
 * The psu template: its own Python suite, and psu.py on its simulated supply
 * with two channels. The tier needs python3, and no hardware.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { templatesDirectory } from '../src/domain/templates.ts';

const TEMPLATE = join(templatesDirectory, 'psu');
const PSU = join(TEMPLATE, 'psu.py');

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

/** The channels of the supply under test: a radio rail, and a small LED rail. */
const CONFIG = {
	name: 'psu',
	driver: 'hm310p',
	channels: {
		ch1: { label: 'radio', max_voltage: 5, max_current: 0.5, max_power: 2.5 },
		ch2: { label: 'led', max_voltage: 3, max_current: 0.05, max_power: 0.15 },
	},
};

/**
 * A command on one simulated supply with the channels of `config`: the exit
 * status, the JSON it printed, and its error. The locks live in the
 * directory of the test, so a test never meets another process.
 */
async function supply(config: object = CONFIG) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-psu-'));
	directories.push(directory);
	const state = join(directory, 'sim.json');
	const path = join(directory, 'psu.json');
	await writeFile(path, JSON.stringify(config));
	const env = {
		...process.env,
		PSU_LOCK_DIR: join(directory, 'locks'),
		PYTHONDONTWRITEBYTECODE: '1',
	};
	return (...args: string[]) => {
		const done = spawnSync('python3', [PSU, '--config', path, '--sim', state, ...args, '--json'], {
			encoding: 'utf8',
			env,
		});
		return {
			status: done.status,
			json: done.stdout ? JSON.parse(done.stdout) : undefined,
			error: done.stderr.trim(),
		};
	};
}

describe.skipIf(!python)('the psu template', () => {
	it('passes its own Python suite', () => {
		const done = spawnSync('python3', ['-B', '-m', 'unittest'], {
			cwd: TEMPLATE,
			encoding: 'utf8',
		});
		expect(done.stderr + done.stdout, done.stderr).toMatch(/OK/);
		expect(done.status).toBe(0);
	}, 30_000);
});

describe.skipIf(!python)('psu.py on a simulated supply with two channels', () => {
	it('shows both channels, with the output off', async () => {
		const psu = await supply();
		const status = psu('status').json;
		expect(Object.keys(status)).toEqual(['ch1', 'ch2']);
		expect(status.ch1).toMatchObject({ output: 'off', tripped: [] });
		expect(status.ch2.limits).toEqual({ max_voltage: 3, max_current: 0.05, max_power: 0.15 });
		expect(psu('info').json).toMatchObject({ driver: 'sim', capabilities: ['mode', 'ocp', 'ovp'] });
	});

	it('sets a channel within its limits, and refuses each value above them', async () => {
		const psu = await supply();
		expect(psu('set', '--channel', 'ch1', '--voltage', '3.3', '--current', '0.02').json).toEqual({
			ch1: { voltage: 3.3, current: 0.02, output: 'off' },
		});
		const refusals = [
			psu('set', '--channel', 'ch1', '--voltage', '6'),
			psu('set', '--channel', 'ch2', '--voltage', '4'),
			psu('set', '--channel', 'ch2', '--current', '0.1'),
			psu('set', '--channel', 'ch1', '--voltage', '-1'),
		];
		for (const refused of refusals) expect(refused.status).toBe(1);
		expect(refusals[0]?.error).toBe(
			'psu: The setpoints of ch1: the voltage 6 V is above the limit 5 V of psu.json.',
		);
		// A refused command changes nothing.
		expect(psu('status').json.ch1.setpoints).toEqual({ voltage: 3.3, current: 0.02 });
		expect(psu('status').json.ch2.setpoints).toEqual({ voltage: 0, current: 0 });
	});

	it('turns an output on and off, and reads the output on its load', async () => {
		const psu = await supply();
		psu('set', '--channel', 'ch1', '--voltage', '1.0', '--current', '0.5');
		expect(psu('output', '--channel', 'ch1', 'on').json).toEqual({ ch1: { output: 'on' } });
		// 1 V on 100 ohm: constant voltage, 10 mA.
		expect(psu('measure').json.ch1).toMatchObject({ voltage: 1, current: 0.01, power: 0.01 });
		expect(psu('status').json.ch1.mode).toBe('cv');
		psu('set', '--channel', 'ch1', '--voltage', '3.3', '--current', '0.02');
		// 3.3 V wants 33 mA: the 20 mA limit holds, so the voltage falls to 2 V.
		expect(psu('measure').json.ch1).toMatchObject({ voltage: 2, current: 0.02, power: 0.04 });
		expect(psu('status').json.ch1.mode).toBe('cc');
		expect(psu('measure').json.ch2).toMatchObject({ voltage: 0, current: 0 });
		expect(psu('output', '--channel', 'ch1', 'off').json).toEqual({ ch1: { output: 'off' } });
		expect(psu('measure').json.ch1).toMatchObject({ voltage: 0, current: 0, power: 0 });
	});

	it('requires --channel on a supply with two channels, and defaults it on one', async () => {
		const psu = await supply();
		const missing = psu('set', '--voltage', '1');
		expect(missing.status).toBe(1);
		expect(missing.error).toBe(
			'psu: The supply has several channels: use --channel with one of ch1, ch2.',
		);
		expect(psu('output', 'on').status).toBe(1);
		const single = await supply({ ...CONFIG, channels: { ch1: CONFIG.channels.ch1 } });
		expect(single('set', '--voltage', '1', '--current', '0.1').json).toEqual({
			ch1: { voltage: 1, current: 0.1, output: 'off' },
		});
	});

	it('turns every channel off with `output off` and no channel', async () => {
		const psu = await supply();
		for (const channel of ['ch1', 'ch2']) {
			psu('set', '--channel', channel, '--voltage', '1', '--current', '0.02');
			psu('output', '--channel', channel, 'on');
		}
		expect(psu('output', 'off').json).toEqual({ ch1: { output: 'off' }, ch2: { output: 'off' } });
		expect(psu('status').json.ch2.output).toBe('off');
	});

	it('refuses the raw read on a driver without registers, and a missing config in one line', async () => {
		const psu = await supply();
		expect(psu('read', '0x10', '2').error).toBe(
			'psu: The driver for Simulated supply, 2 channels cannot read raw registers.',
		);
		const done = spawnSync('python3', ['-B', PSU, '--config', '/no/such/psu.json', 'status'], {
			encoding: 'utf8',
		});
		expect(done.status).toBe(1);
		expect(done.stderr).toMatch(/^psu: The config \/no\/such\/psu.json cannot be read/);
		expect(done.stderr).not.toContain('Traceback');
	});
});
