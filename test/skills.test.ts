import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import { byAgent, callTool, quiet, say, scripted, settled } from '@ambionframework/ambion/testing';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { SHARED_SKILLS, skillsDirectory, specialistSkills } from '../src/domain/skills.ts';

const specialists = ['researcher', 'engineer'];

/** The names of the skill folders of one specialist. */
const skillNames = async (specialist: string) =>
	(await specialistSkills(specialist)).skills.map((skill) => skill.name).sort();

/** The text of one SKILL.md. */
const skillText = (specialist: string, skill: string): string =>
	readFileSync(join(skillsDirectory, specialist, skill, 'SKILL.md'), 'utf8');

describe('the rules that a skill holds', () => {
	it.each([
		['engineer', 'check-a-photo', 'a transistor, a voltage'],
		['engineer', 'check-a-photo', 'pass, fail, or unclear'],
		['engineer', 'check-a-photo', 'a photo or a measurement that you'],
		['engineer', 'guide-a-build-step', 'The power stays off until the person confirms'],
		['engineer', 'guide-a-build-step', 'one small step at a time'],
		['researcher', 'write-a-test-plan', 'Write the outline of the plan even when'],
		['researcher', 'write-a-test-plan', 'also when another specialist already answered'],
	])('puts the rule in %s/%s: %s', (specialist, skill, rule) => {
		expect(skillText(specialist, skill).replace(/\s+/g, ' ')).toContain(rule);
	});
});

describe('the Workbench skills', () => {
	it('holds one directory of skills for each specialist, and the shared one', () => {
		const directories = readdirSync(skillsDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(directories).toEqual([...specialists, SHARED_SKILLS].sort());
	});

	it.each(specialists)('loads the skills of %s, each with a description', async (specialist) => {
		const set = await specialistSkills(specialist);
		expect(set.skills.length).toBeGreaterThan(0);
		for (const skill of set.skills) expect(skill.description, skill.name).toMatch(/\bUse it\b/);
	});

	it('gives every specialist the shared skills', async () => {
		const shared = await skillNames(SHARED_SKILLS);
		expect(shared).toContain('keep-notes');
		for (const specialist of specialists)
			expect(await skillNames(specialist), specialist).toEqual(expect.arrayContaining(shared));
	});

	it('lists the skills of a specialist in its guidance, and no skill of another', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			for (const seat of built.specialists) {
				const guidance = seat.executor.guidance ?? '';
				const own = await skillNames(seat.name);
				for (const name of own) expect(guidance, seat.name).toContain(`~/.skills/${name}/SKILL.md`);
				for (const other of specialists.filter((other) => other !== seat.name))
					for (const name of (await skillNames(other)).filter((skill) => !own.includes(skill)))
						expect(guidance, seat.name).not.toContain(`~/.skills/${name}/`);
			}
		} finally {
			await workspace.dispose();
		}
	});

	it('copies the skills of a specialist into its home, where the seat reads them', async () => {
		const person = people[0];
		if (!person) throw new Error('No person.');
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		const built = await team(workspace);
		const room = await startRoom({
			name: 'skills',
			goal: 'Read a skill.',
			agents: built.specialists,
			runtime: createRuntime(),
			execution: scripted(
				byAgent({
					engineer: (step, _seat, call) => {
						if (call === 1) return callTool('read', { path: '~/.skills/scan-the-bench/SKILL.md' });
						if (call === 2) return say(`Read: ${step.results.at(-1)?.text}`);
						return quiet();
					},
				}),
			),
			seats: { engineer: 'named' },
		});
		try {
			await (await room.visit(person)).send({ text: 'What is connected?', to: 'engineer' });
			await settled(room);
			const said = (await room.read()).messages.filter((message) => message.kind === 'said');
			expect(
				said.some((message) => message.from === 'engineer' && message.text.includes('device-scan')),
			).toBe(true);
		} finally {
			await room.stop();
			await workspace.dispose();
		}
	});

	it('lets a skill of a specialist replace a shared skill of the same name', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'workbench-skills-'));
		const skill = (name: string, text: string) =>
			`---\nname: ${name}\ndescription: ${text}. Use it now.\n---\nSteps.\n`;
		try {
			for (const [folder, name, text] of [
				['shared', 'notes', 'Shared notes'],
				['shared', 'rules', 'Shared rules'],
				['engineer', 'notes', 'Own notes'],
			] as const) {
				mkdirSync(join(directory, folder, name), { recursive: true });
				writeFileSync(join(directory, folder, name, 'SKILL.md'), skill(name, text));
			}
			const set = await specialistSkills('engineer', directory);
			const described = Object.fromEntries(set.skills.map((s) => [s.name, s.description]));
			expect(described).toEqual({
				notes: 'Own notes. Use it now.',
				rules: 'Shared rules. Use it now.',
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('skips a file that a tool writes beside the skills', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'workbench-skills-'));
		try {
			mkdirSync(join(directory, 'shared'), { recursive: true });
			mkdirSync(join(directory, 'engineer', 'scan'), { recursive: true });
			writeFileSync(join(directory, 'engineer', '.DS_Store'), 'x');
			mkdirSync(join(directory, 'engineer', 'scan', 'scripts', '__pycache__'), { recursive: true });
			writeFileSync(join(directory, 'engineer', 'scan', 'scripts', '__pycache__', 'm.pyc'), 'x');
			writeFileSync(
				join(directory, 'engineer', 'scan', 'SKILL.md'),
				'---\nname: scan\ndescription: Scan. Use it now.\n---\nSteps.\n',
			);
			const set = await specialistSkills('engineer', directory);
			expect(set.skills.map((skill) => skill.name)).toEqual(['scan']);
			expect(Object.keys(set.files).filter((path) => path.includes('__pycache__'))).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
