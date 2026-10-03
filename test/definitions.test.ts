import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { shared, team } from '../src/domain/definitions.ts';
import { seats } from '../src/domain/scenarios.ts';
import { templateInstructions, templates } from '../src/domain/templates.ts';
import { resolveRef } from '../src/view/refs.ts';

describe('the team instructions', () => {
	it('name the URI form of a workspace file', () => {
		expect(shared).toContain('file:///<path>');
	});

	it('give examples that the terminal resolves', () => {
		const known = { room: 'radio-kit', files: ['/shared/kit.md'], seqs: new Set<number>() };
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
	it('listens at broadcast in a room with no seats of its own, like the other specialists', () => {
		expect(seats).toEqual({
			datasheets: 'broadcast',
			experiments: 'broadcast',
			engineer: 'broadcast',
		});
	});

	it('owns every template, and no other specialist is told to fork one of its own', () => {
		const owned = ['device-scan', 'usb-camera', 'psu', 'build-procedure'];
		for (const name of owned)
			expect(templates.find((template) => template.name === name)?.specialists).toEqual([
				'engineer',
			]);
		expect(templateInstructions('engineer')).toContain('the build-procedure template');
		for (const other of ['datasheets', 'experiments'])
			for (const name of owned) expect(templateInstructions(other)).not.toContain(name);
	});

	it('is in the briefing of the assistant, which tells it how to reach a seat at named', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const briefing = instructionsOf(built.assistant);
			expect(briefing).toContain('The Engineer watches the bench with the camera');
			expect(briefing).toContain('The Engineer also guides an assembly step by step');
			expect(briefing).toContain('directed say');
			expect(briefing).not.toMatch(/\b(Builder|Instruments)\b/);
		} finally {
			await workspace.dispose();
		}
	});

	it('holds the rules that keep a part from being called right on weak evidence', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const engineer = built.specialists.find((seat) => seat.name === 'engineer');
			const rules = engineer ? instructionsOf(engineer) : '';
			for (const rule of [
				'Say that a part sits right only when a photo or a measurement that you cite shows it.',
				'The power stays off until the person confirms the checks of the build.',
				'answer pass, fail, or unclear',
				'Record each step that the person completes in the build folder of the notes',
				'a transistor, a voltage regulator',
			])
				expect(rules).toContain(rule);
		} finally {
			await workspace.dispose();
		}
	});

	it('holds the rules of the bench, and looks with the camera before it asks for a photo', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const engineer = built.specialists.find((seat) => seat.name === 'engineer');
			const rules = engineer ? instructionsOf(engineer) : '';
			for (const rule of [
				'follow the scan-the-bench skill',
				'Follow the drive-the-power-supply skill to run the HM310P.',
				'ask the person before the first run that drives an output',
				'Scan a network with `--subnet` only when the person names the subnet.',
				'Start a long script with a `name`, and read its end with `wait` or `status`.',
				'follow the observe-the-camera skill',
				'Ask the person for a photo with /attach only when the camera cannot show the part.',
			])
				expect(rules).toContain(rule);
			expect(built.specialists.map((seat) => seat.name)).toEqual([
				'datasheets',
				'experiments',
				'engineer',
			]);
		} finally {
			await workspace.dispose();
		}
	});
});
