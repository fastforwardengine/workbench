import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { radioProject, sharedRules, team } from '../src/domain/definitions.ts';
import { scenarios, seats, seedFiles } from '../src/domain/scenarios.ts';
import { seedWorkspace } from '../src/host/seed.ts';

const specialists = ['datasheets', 'experiments', 'instruments', 'builder'];

describe('the rooms of the FM radio', () => {
	it('are one for each phase, in order', () => {
		expect(scenarios.map((scenario) => scenario.name)).toEqual([
			'radio-kit',
			'radio-tune',
			'radio-build',
			'radio-firmware',
		]);
	});

	it('seat every specialist once, and give each room an owner at broadcast', () => {
		for (const scenario of scenarios) {
			expect(Object.keys(scenario.seats).sort(), scenario.name).toEqual([...specialists].sort());
			expect(Object.values(scenario.seats), scenario.name).toContain('broadcast');
		}
	});

	it('name the owners of each phase', () => {
		const owners = (name: string) =>
			Object.entries(scenarios.find((scenario) => scenario.name === name)?.seats ?? {})
				.filter(([, attention]) => attention === 'broadcast')
				.map(([seat]) => seat)
				.sort();
		expect(owners('radio-kit')).toEqual(['builder', 'datasheets']);
		expect(owners('radio-tune')).toEqual(['experiments', 'instruments']);
		expect(owners('radio-build')).toEqual(['builder', 'instruments']);
		expect(owners('radio-firmware')).toEqual(['datasheets', 'instruments']);
	});

	it('carry a goal, a header pattern, and a prompt for /try', () => {
		for (const scenario of scenarios) {
			expect(scenario.goal.length, scenario.name).toBeGreaterThan(40);
			expect(scenario.pattern, scenario.name).toContain('→');
			expect(scenario.prompt.length, scenario.name).toBeGreaterThan(20);
		}
	});

	it('leave the default seats with the Builder at named', () => {
		expect(seats.builder).toBe('named');
	});
});

describe('the seed of the workspace', () => {
	it('holds the kit file, and points at the notes and the library', () => {
		const files = seedFiles();
		const kit = files['/shared/kit.md'];
		expect(kit).toContain('FM radio kit');
		expect(kit).toContain('shared/notes');
		expect(kit).toContain('STC8G1K17');
		expect(Object.keys(files)).not.toContain('/shared/bench.md');
		expect(Object.keys(files)).not.toContain('/shared/notes.md');
	});

	it('names every room in the kit file', () => {
		const kit = seedFiles()['/shared/kit.md'] ?? '';
		for (const scenario of scenarios) expect(kit, scenario.name).toContain(scenario.name);
	});

	it('replaces a file by path from the overrides, and keeps the others', () => {
		const files = seedFiles({ '/shared/kit.md': 'other' });
		expect(files['/shared/kit.md']).toBe('other');
		expect(files['/library/README.md']).toBe(seedFiles()['/library/README.md']);
	});
});

describe('the shared rules', () => {
	it('carry the project text, and point at the notes and their skill', () => {
		const rules = sharedRules('A test project.');
		expect(rules).toContain('A test project.');
		expect(rules).toContain('shared/notes');
		expect(rules).toContain('keep-notes');
		expect(rules).not.toContain('bench.md');
		expect(sharedRules(radioProject)).toContain(radioProject);
	});
});

const instructionsOf = (seat: { executor: unknown }): string =>
	(seat.executor as { instructions: string }).instructions;

describe('the project of a team', () => {
	it('opens the instructions of every seat, and defaults to the radio', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const other = await team(workspace, 'The project is a test project. ');
			const radio = await team(workspace);
			for (const seat of [...other.specialists, other.assistant])
				expect(instructionsOf(seat)).toContain('The project is a test project.');
			for (const seat of [...radio.specialists, radio.assistant])
				expect(instructionsOf(seat)).toContain('an FM radio kit');
		} finally {
			await workspace.dispose();
		}
	});
});

describe('the seed of a workspace', () => {
	it('writes an override in place of the radio file, and no file over an edit', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			await seedWorkspace(workspace, { '/shared/kit.md': 'the LED kit' });
			await seedWorkspace(workspace, { '/shared/kit.md': 'a later kit' });
			await workspace.use(workspace.mirrorAgent, async (env) => {
				const kit = await env.readTextFile('/shared/kit.md');
				expect(kit.ok && kit.value).toBe('the LED kit');
				const index = await env.readTextFile('/library/README.md');
				expect(index.ok && index.value).toContain('rda5807fp.md');
			});
		} finally {
			await workspace.dispose();
		}
	});
});
