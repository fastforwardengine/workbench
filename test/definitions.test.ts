import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { PREFERENCE, people, shared, team } from '../src/domain/definitions.ts';
import { seats } from '../src/domain/room.ts';
import { VOICE_MARK } from '../src/domain/voice.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { resolveRef } from '../src/view/refs.ts';

describe('the team instructions', () => {
	it('tell every seat to read the notes before it acts', () => {
		expect(shared).toContain('Before you act, follow the keep-notes skill to read them.');
	});

	it('name the URI form of a workspace file', () => {
		expect(shared).toContain('file:///<path>');
	});

	it('give examples that the terminal resolves', () => {
		const known = { room: 'build', files: ['/library/rda5807fp.md'], seqs: new Set<number>() };
		const examples = [...shared.matchAll(/file:\/\/\/[A-Za-z0-9_./-]+[A-Za-z0-9]/g)].map(
			(match) => match[0],
		);
		expect(examples).toEqual(['file:///library/rda5807fp.md']);
		for (const example of examples) expect(resolveRef(example, known).target).toBeDefined();
	});
});

/** The instructions of a Pi seat. */
const instructionsOf = (seat: { executor: unknown }): string =>
	(seat.executor as { instructions: string }).instructions;

/** The rules of one group of a prompt: the lines of its section. */
const groupOf = (prompt: string, header: string): string[] => {
	const section = prompt.split('\n\n').find((part) => part.startsWith(`## ${header}\n`));
	return section ? section.split('\n').slice(1) : [];
};

/** Build the team, and give the instructions of each specialist by name. */
async function prompts(project?: string): Promise<Record<string, string>> {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
	});
	try {
		const built = await team(workspace, project);
		return Object.fromEntries(built.specialists.map((seat) => [seat.name, instructionsOf(seat)]));
	} finally {
		await workspace.dispose();
	}
}

describe('the structure of a prompt', () => {
	it('opens with the project, then five groups in order, each rule on its own line', async () => {
		for (const prompt of Object.values(await prompts('A test project.'))) {
			const parts = prompt.split('\n\n');
			expect(parts[0]).toBe('A test project.');
			expect(parts.slice(1).map((part) => part.split('\n')[0])).toEqual([
				'## Project',
				'## Evidence',
				'## Constraints',
				'## Background',
				'## Speaking',
			]);
			for (const part of parts.slice(1))
				for (const line of part.split('\n').slice(1)) expect(line).toMatch(/^- \S/);
		}
	});

	it('keeps each rule in its group', async () => {
		const { engineer, researcher } = await prompts();
		expect(groupOf(engineer ?? '', 'Evidence').join('\n')).toContain('file:///<path>');
		expect(groupOf(engineer ?? '', 'Evidence').join('\n')).toContain('a planned value');
		expect(groupOf(engineer ?? '', 'Constraints').join('\n')).toContain('not an edit');
		expect(groupOf(researcher ?? '', 'Evidence')).toContain(
			'- Never state a value without a datasheet path.',
		);
	});

	it('gives every specialist the preference of the person, from one source', async () => {
		expect(people[0]?.preferences).toBe(PREFERENCE);
		for (const prompt of Object.values(await prompts()))
			expect(groupOf(prompt, 'Speaking')).toContain(`- ${PREFERENCE}`);
	});

	it('gives every specialist the rule for a voice message, built from the mark', async () => {
		for (const prompt of Object.values(await prompts())) {
			const rule = groupOf(prompt, 'Speaking').find((line) => line.includes('speech transcript'));
			expect(rule).toContain(`starts with \`${VOICE_MARK.trim()}\``);
			expect(rule).toContain('at most 25 words');
			expect(rule).toContain('"9 volts"');
		}
	});

	it('states one citation rule: a read-only file by URI, a changing file by snapshot, a note by path', () => {
		const rule = shared.split('\n').find((line) => line.startsWith('- Cite what you rely on'));
		expect(rule).toContain('Cite a file of /library, which is read-only');
		expect(rule).toContain('file:///<path>');
		expect(rule).toContain(
			'Cite a file that can change, such as /shared/kit.md, by its snapshot ref',
		);
		expect(rule).toContain('Inside a note, write the library/ path');
	});

	it('does not name the project as a room, and drops the rules that the kernel or the screen holds', async () => {
		expect(shared).not.toContain('One room');
		for (const prompt of Object.values(await prompts())) {
			expect(prompt).not.toContain('Read a skill of ~/.skills');
			expect(prompt).not.toContain('The terminal opens a ref');
		}
	});
});

describe('the Engineer', () => {
	it('listens at broadcast in every room, and the Researcher waits at named', () => {
		expect(seats).toEqual({
			researcher: 'named',
			engineer: 'broadcast',
		});
	});

	it('asks the Researcher with a directed say, because the Researcher waits at named', async () => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		try {
			const built = await team(workspace);
			const engineer = built.specialists.find((seat) => seat.name === 'engineer');
			expect(engineer && instructionsOf(engineer)).toContain('ask the Researcher with `to`');
			expect(built.specialists.map((seat) => seat.name)).toEqual(['researcher', 'engineer']);
		} finally {
			await workspace.dispose();
		}
	});

	it('tells each specialist to say a result with no `to`, and the Engineer to hand a result to the Researcher with `to`', async () => {
		for (const prompt of Object.values(await prompts())) {
			const speaking = groupOf(prompt, 'Speaking').join('\n');
			expect(speaking).toContain('In a root room, say a result with no `to`.');
			expect(speaking).toContain('Post one message for each result.');
			for (const word of ['assignment', 'broadcast', 'acknowledgment'])
				expect(prompt).not.toContain(word);
		}
	});

	it('names the skills and the hard rules of the Engineer, and copies no step of a skill', async () => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		try {
			const built = await team(workspace);
			const engineer = built.specialists.find((seat) => seat.name === 'engineer');
			const rules = engineer ? instructionsOf(engineer) : '';
			for (const rule of [
				'Follow the scan-the-bench skill to find the devices of the bench',
				'Follow the drive-the-power-supply skill to run a power supply',
				'the observe-the-camera skill',
				'Follow the guide-a-build-step skill',
				'the check-a-photo skill',
				'Change no setting and no output of a device outside a script from a template.',
				'you cannot hold a tool.',
			])
				expect(rules).toContain(rule);
			expect(rules).toContain(
				'In a root room, ask the person before the first run that turns on an output of a device.',
			);
			expect(groupOf(rules, 'Speaking').join('\n')).toContain(
				'In a root room, the Researcher hears only a directed say. Hand it a result that it needs with `to`.',
			);
			for (const copy of [
				'a transistor',
				'pass, fail, or unclear',
				'The power stays off',
				'TBD',
				'Record each step',
			])
				expect(rules).not.toContain(copy);
			expect(built.specialists.map((seat) => seat.name)).toEqual(['researcher', 'engineer']);
		} finally {
			await workspace.dispose();
		}
	});

	it('names the skills of the Researcher, and keeps its datasheet rule', async () => {
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
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
