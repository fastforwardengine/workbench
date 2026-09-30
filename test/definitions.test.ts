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

describe('the Builder', () => {
	it('listens at named in a room with no seats of its own, and the three others at broadcast', () => {
		expect(seats).toEqual({
			datasheets: 'broadcast',
			experiments: 'broadcast',
			instruments: 'broadcast',
			builder: 'named',
		});
	});

	it('owns the build-procedure template, and no other specialist is told to fork it', () => {
		expect(templates.find((template) => template.name === 'build-procedure')?.specialists).toEqual([
			'builder',
		]);
		expect(templateInstructions('builder')).toContain('the build-procedure template');
		for (const other of ['datasheets', 'experiments', 'instruments'])
			expect(templateInstructions(other)).not.toContain('build-procedure');
	});

	it('is in the briefing of the assistant, which tells it how to reach the Builder', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const briefing = instructionsOf(built.assistant);
			expect(briefing).toContain('Builder guides an assembly step by step');
			expect(briefing).toContain('directed say');
		} finally {
			await workspace.dispose();
		}
	});

	it('holds the rules that keep a part from being called right on weak evidence', async () => {
		const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
		try {
			const built = await team(workspace);
			const builder = built.specialists.find((seat) => seat.name === 'builder');
			const rules = builder ? instructionsOf(builder) : '';
			for (const rule of [
				'Say that a part sits right only when a photo or a measurement that you cite shows it.',
				'The power stays off until the person confirms the checks of the build.',
				'answer pass, fail, or unclear',
				'When the person permits file edits',
				'a transistor, a voltage regulator',
			])
				expect(rules).toContain(rule);
		} finally {
			await workspace.dispose();
		}
	});
});
