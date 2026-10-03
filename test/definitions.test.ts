import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { shared, team } from '../src/domain/definitions.ts';
import { seats } from '../src/domain/room.ts';
import { resolveRef } from '../src/view/refs.ts';

describe('the team instructions', () => {
	it('tell every seat to read the notes before it acts', () => {
		expect(shared).toContain('Before you act, follow the keep-notes skill to read them.');
	});

	it('name the URI form of a workspace file', () => {
		expect(shared).toContain('file:///<path>');
	});

	it('give examples that the terminal resolves', () => {
		const known = { room: 'build', files: ['/shared/kit.md'], seqs: new Set<number>() };
		const examples = [...shared.matchAll(/file:\/\/\/[A-Za-z0-9_./-]+[A-Za-z0-9]/g)].map(
			(match) => match[0],
		);
		expect(examples).toEqual(['file:///shared/kit.md']);
		for (const example of examples) expect(resolveRef(example, known).target).toBeDefined();
	});
});

/** The instructions of a Pi seat. */
const instructionsOf = (seat: { executor: unknown }): string =>
	(seat.executor as { instructions: string }).instructions;

describe('the Engineer', () => {
	it('listens at broadcast in every room, and the Researcher waits at named', () => {
		expect(seats).toEqual({
			researcher: 'named',
			engineer: 'broadcast',
		});
	});

	it('asks the Researcher with a directed say, because the Researcher waits at named', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const engineer = built.specialists.find((seat) => seat.name === 'engineer');
			expect(engineer && instructionsOf(engineer)).toContain('ask the Researcher with `to`');
			expect(built.specialists.map((seat) => seat.name)).toEqual(['researcher', 'engineer']);
		} finally {
			await workspace.dispose();
		}
	});

	it('tells each specialist to say its result to the room', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			for (const seat of built.specialists) {
				expect(instructionsOf(seat)).toContain('Say your result to the room, with no `to`');
			}
		} finally {
			await workspace.dispose();
		}
	});

	it('names the skills and the hard rules of the Engineer, and copies no step of a skill', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const engineer = built.specialists.find((seat) => seat.name === 'engineer');
			const rules = engineer ? instructionsOf(engineer) : '';
			for (const rule of [
				'follow the scan-the-bench skill',
				'Follow the drive-the-power-supply skill to run a power supply',
				'the observe-the-camera skill',
				'Follow the guide-a-build-step skill',
				'the check-a-photo skill',
				'ask the person before the first run that drives an output',
				'You cannot hold a tool.',
				'Record each step that the person completes in the build folder of the notes',
			])
				expect(rules).toContain(rule);
			for (const copy of ['a transistor', 'pass, fail, or unclear', 'The power stays off', 'TBD'])
				expect(rules).not.toContain(copy);
			expect(built.specialists.map((seat) => seat.name)).toEqual(['researcher', 'engineer']);
		} finally {
			await workspace.dispose();
		}
	});

	it('names the skills of the Researcher, and keeps its datasheet rule', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const researcher = built.specialists.find((seat) => seat.name === 'researcher');
			const rules = researcher ? instructionsOf(researcher) : '';
			expect(rules).toContain('cite-a-limit skill');
			expect(rules).toContain('write-a-test-plan skill');
			expect(rules).toContain('Never state a value without a datasheet path.');
			expect(rules).not.toContain('TBD');
		} finally {
			await workspace.dispose();
		}
	});
});
