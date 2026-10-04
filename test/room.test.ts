import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { radioProject, sharedRules, team } from '../src/domain/definitions.ts';
import { buildRoom, seats } from '../src/domain/room.ts';
import { labRepositories } from '../src/host/repositories.ts';

describe('the build room', () => {
	it('is the one seeded room, and carries a goal, a header pattern, and a prompt for /try', () => {
		expect(buildRoom.name).toBe('build');
		expect(buildRoom.goal.length).toBeGreaterThan(40);
		expect(buildRoom.pattern).toContain('→');
		expect(buildRoom.prompt.length).toBeGreaterThan(20);
	});

	it('seats the Researcher at named and the Engineer at broadcast', () => {
		expect(seats).toEqual({ researcher: 'named', engineer: 'broadcast' });
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
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		try {
			const other = await team(workspace, 'The project is a test project. ');
			const radio = await team(workspace);
			for (const seat of other.specialists)
				expect(instructionsOf(seat)).toContain('The project is a test project.');
			for (const seat of radio.specialists)
				expect(instructionsOf(seat)).toContain('an FM radio kit');
		} finally {
			await workspace.dispose();
		}
	});
});
