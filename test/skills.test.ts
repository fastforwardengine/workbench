import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import { byAgent, callTool, quiet, say, scripted, settled } from '@ambionframework/ambion/testing';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { agentSkills, skillsDirectory } from '../src/domain/skills.ts';

const specialists = ['datasheets', 'experiments', 'instruments', 'builder'];

/** The names of the skill folders of one agent. */
const skillNames = async (agent: string) =>
	(await agentSkills(agent)).skills.map((skill) => skill.name).sort();

describe('the Workbench skills', () => {
	it('holds one directory of skills for each specialist, and nothing else', () => {
		const directories = readdirSync(skillsDirectory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(directories).toEqual([...specialists].sort());
	});

	it.each(specialists)('loads the skills of %s, each with a description', async (agent) => {
		const set = await agentSkills(agent);
		expect(set.skills.length).toBeGreaterThan(0);
		for (const skill of set.skills) expect(skill.description, skill.name).toMatch(/\bUse it\b/);
	});

	it('lists the skills of a specialist in its guidance, and no skill of another', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			for (const seat of built.specialists) {
				const guidance = seat.executor.guidance ?? '';
				const own = await skillNames(seat.name);
				for (const name of own) expect(guidance, seat.name).toContain(`~/.skills/${name}/SKILL.md`);
				for (const other of specialists.filter((agent) => agent !== seat.name))
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
			assistant: built.assistant,
			agents: built.specialists,
			runtime: createRuntime(),
			execution: scripted(
				byAgent({
					assistant: (_step, _seat, call) =>
						call === 1 ? say('Scan the bench.', 'instruments') : quiet(),
					instruments: (step, _seat, call) => {
						if (call === 1) return callTool('read', { path: '~/.skills/scan-the-bench/SKILL.md' });
						if (call === 2) return say(`Read: ${step.results.at(-1)?.text}`, 'assistant');
						return quiet();
					},
				}),
			),
			seats: { instruments: 'named' },
		});
		try {
			await (await room.visit(person)).send({ text: 'What is connected?' });
			await settled(room);
			const said = (await room.read()).messages.filter((message) => message.kind === 'said');
			expect(
				said.some(
					(message) => message.from === 'instruments' && message.text.includes('device-scan'),
				),
			).toBe(true);
		} finally {
			await room.stop();
			await workspace.dispose();
		}
	});

	it('skips a file that a tool writes beside the skills', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'workbench-skills-'));
		try {
			mkdirSync(join(directory, 'instruments', 'scan'), { recursive: true });
			writeFileSync(join(directory, 'instruments', '.DS_Store'), 'x');
			writeFileSync(
				join(directory, 'instruments', 'scan', 'SKILL.md'),
				'---\nname: scan\ndescription: Scan. Use it now.\n---\nSteps.\n',
			);
			const set = await agentSkills('instruments', directory);
			expect(set.skills.map((skill) => skill.name)).toEqual(['scan']);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
